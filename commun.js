/* ===================================================================
   commun.js : le fonctionnement du site, partagé par lycees.html et
   universites.html. Ce qui change d'une page à l'autre est décrit dans
   window.CONFIG, en bas de chaque page (BLOC JS 0b ci-dessous).
   =================================================================== */
/* ===================================================================
   BLOC JS 0 : CONNEXION À SUPABASE
   L'URL et la clé "publishable" sont publiques : elles peuvent figurer
   dans le code. Ce sont les règles d'accès (schema.sql) qui protègent
   les données, pas le secret de ces valeurs.
   =================================================================== */
const SUPABASE_URL = "https://tmantitdvmctbxbvzlbf.supabase.co";
const SUPABASE_CLE = "sb_publishable_nXZelcAhkvD63yTFmdbzOA_ekhnnpEH";
// Clé de SITE Turnstile (publique). La clé secrète, elle, reste dans Supabase.
const TURNSTILE_CLE_SITE = "0x4AAAAAAF75nUOZOzPumPUl";

// Petite fonction qui envoie une requête à la base et renvoie la réponse.
// "chemin" désigne une table et des filtres, par exemple :
//   "motifs?select=id,label"  -> lit les colonnes id et label de la table motifs
async function api(chemin, options = {}) {
  const reponse = await fetch(`${SUPABASE_URL}/rest/v1/${chemin}`, {
    ...options,
    headers: {
      apikey: SUPABASE_CLE,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!reponse.ok) throw new Error(`Erreur ${reponse.status} : ${await reponse.text()}`);
  const texte = await reponse.text();
  return texte ? JSON.parse(texte) : null;
}
/* ===================================================================
   BLOC JS 0b : LA PAGE (LYCÉES OU UNIVERSITÉS)
   Ce fichier est partagé par lycees.html et universites.html. Chaque
   page définit, juste avant de le charger, un objet window.CONFIG :
     type        : "lycee" ou "universite" (transmis à la base)
     liste       : fichier de la liste ("lycees.json"...)
     route       : mot utilisé dans les liens (#carte/lycee/...)
     cleMien     : nom de la mémoire du navigateur pour "Mon lycée"
     mots        : le vocabulaire affiché (voir lycees.html)
     categories  : les catégories du graphique "par voie" / "par type"
   =================================================================== */
const CONFIG = window.CONFIG;
const M = CONFIG.mots;
const ROUTE = CONFIG.route;
const TYPE = { type_etab: CONFIG.type };   // paramètre envoyé aux fonctions de la base

// "1 appareil", "3 appareils"
const appareils = (n) => `${n} appareil${n > 1 ? "s" : ""}`;

/* ===================================================================
   BLOC JS 1 : LES DONNÉES DE CONFIGURATION
   Ce sont les seules lignes que tu modifies pour personnaliser le site.
   =================================================================== */

// Les motifs sont chargés depuis la table "motifs" de la base : pour en
// ajouter, tu ajoutes une ligne dans Supabase (Table Editor > motifs).
let MOTIFS = [];

async function chargerMotifs() {
  MOTIFS = await api("motifs?select=id,label,perturbe,actif&order=id");
  // Les motifs sont communs aux deux pages : sur celle des universités,
  // "Lycée bloqué" devient "Établissement bloqué"
  for (const m of MOTIFS) m.label = m.label.replace(/^Lycée\b/, M.Un);
}

// La liste des établissements est chargée depuis CONFIG.liste
// (lycees.json ou universites.json). Les noms des variables parlent de
// "lycées" pour des raisons historiques : sur la page des universités,
// LYCEES contient les sites de l'enseignement supérieur.
let LYCEES = [];
let INDEX = new Map();     // uai -> lycée, pour retrouver un lycée instantanément

async function chargerLycees() {
  try {
    const reponse = await fetch(CONFIG.liste);
    if (!reponse.ok) throw new Error("HTTP " + reponse.status);
    const donnees = await reponse.json();
    // Pour chaque lycée on pré-calcule un texte "nettoyé" (sans accents,
    // en minuscules) : la recherche sera ainsi rapide à chaque lettre tapée.
    // Universités : on cherche aussi dans le nom de l'établissement, son
    // sigle et les noms des composantes du site ("UFR de droit"...)
    LYCEES = donnees.map((l) => ({ ...l, recherche: normaliser(
      [l.nom, l.ville, l.groupe, l.sigle, ...(l.comp ?? [])].filter(Boolean).join(" ")) }));
    INDEX = new Map(LYCEES.map((l) => [l.uai, l]));
  } catch (e) {
    document.getElementById("liste").textContent =
      `Impossible de charger ${CONFIG.liste}. Le site doit être lancé via un serveur local (voir les explications).`;
  }
}

/* ===================================================================
   BLOC JS 2 : L'ÉTAT ACTUEL, CALCULÉ PAR LE SERVEUR
   Les signalements bruts ne sont plus lisibles par le public. La base
   applique elle-même les règles de fiabilité (seuil de 3 appareils
   distincts, expiration à 24 h) et ne renvoie que :
   - perturbes  : les lycées confirmés, avec le nombre de confirmations
   - historique : le nombre de lycées perturbés heure par heure
   (voir schema-etape5.sql). Un visiteur ne peut donc pas contourner
   ces règles en modifiant le code de la page.
   =================================================================== */
let perturbes = [];     // [{ uai, motif, confirmations, dernier }]
let historique = [];    // [{ heure, nb }]
let stats = null;       // objet renvoyé par statistiques() (schema-etape9.sql)
let servicePause = false; // true si l'administrateur a suspendu les signalements

async function chargerEtat() {
  const [liste, histo] = await Promise.all([
    api("rpc/lycees_perturbes", { method: "POST", body: JSON.stringify(TYPE) }),
    api("rpc/historique_horaire", { method: "POST", body: JSON.stringify({ nb_heures: 24, ...TYPE }) }),
  ]);
  perturbes = liste;
  historique = histo;
  // Les statistiques sont chargées à part : si elles échouent (par
  // exemple si schema-etape8.sql n'a pas encore été lancé), le reste
  // du site continue de fonctionner.
  try { stats = await api("rpc/statistiques", { method: "POST", body: JSON.stringify(TYPE) }); }
  catch (e) { console.warn("Statistiques indisponibles", e); stats = null; }
  try { servicePause = (await api("rpc/service_en_pause", { method: "POST", body: "{}" })) === true; }
  catch (e) { servicePause = false; }
}

// Identifiant aléatoire propre à ce navigateur, envoyé avec chaque
// signalement. Il n'est jamais enregistré tel quel : la fonction
// "signaler" le transforme en empreinte secrète (HMAC) côté serveur.
function idAppareil() {
  try {
    let id = localStorage.getItem("appareil-id");
    if (!id) { id = crypto.randomUUID(); localStorage.setItem("appareil-id", id); }
    return id;
  } catch (e) { return null; }
}

/* CAPTCHA : le widget fournit un "jeton" à usage unique que le serveur
   fait vérifier par Cloudflare. Un jeton expire après quelques minutes. */
let widgetCaptcha = null;     // identifiant du widget une fois affiché
let jetonCaptcha = null;      // jeton valide, ou null s'il manque / a expiré

function afficherCaptcha() {
  if (!window.turnstile || widgetCaptcha !== null) return;
  widgetCaptcha = turnstile.render("#captcha", {
    sitekey: TURNSTILE_CLE_SITE,
    callback: (jeton) => { jetonCaptcha = jeton; },
    "expired-callback": () => { jetonCaptcha = null; },
    "error-callback": () => { jetonCaptcha = null; },
  });
}

// Un jeton ne sert qu'une fois : après chaque envoi on en redemande un
function reinitialiserCaptcha() {
  jetonCaptcha = null;
  if (widgetCaptcha !== null) turnstile.reset(widgetCaptcha);
}

/* ===================================================================
   BLOC JS 3 : FONCTIONS UTILITAIRES
   =================================================================== */

// Retrouve un objet par son id (motif ou lycée)
const motifParId = (id) => MOTIFS.find((m) => m.id === id);
const lyceeParUai = (uai) => INDEX.get(uai);

// Enlève les accents et met en minuscules, pour que "ecole" trouve "École"
function normaliser(texte) {
  return texte.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// Affiche une durée lisible : "il y a 2 h", "il y a 40 min"
function depuis(date) {
  const min = Math.round((Date.now() - date) / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  return `il y a ${Math.round(min / 60)} h`;
}

/* ===================================================================
   BLOC JS 4 : AFFICHAGE DE LA LISTE (colonne gauche)
   On construit les éléments avec textContent (et non innerHTML) :
   c'est une protection de sécurité contre l'injection de code.
   La liste vient du serveur : elle ne contient que les lycées
   confirmés par assez d'appareils distincts.
   =================================================================== */
function afficherListe() {
  const ul = document.getElementById("liste");
  ul.textContent = "";

  const tous = perturbes.filter((p) => lyceeParUai(p.uai));
  document.getElementById("resume-nombre").textContent = tous.length === 0
    ? `Aucun ${M.un} confirmé pour le moment.`
    : `${tous.length} ${M.un}(s) actuellement perturbé(s).`;

  // Filtre "région" ou "département" (menu au-dessus de la liste).
  // Valeur du menu : "" (toute la France), "reg:84" ou "dept:069".
  const [type, code] = document.getElementById("filtre-zone").value.split(":");
  const visibles = !code ? tous
    : tous.filter((p) => lyceeParUai(p.uai)[type === "reg" ? "reg" : "dept"] === code);
  document.getElementById("compteur").textContent = visibles.length;

  if (visibles.length === 0) {
    const li = document.createElement("li");
    li.className = "vide";
    li.style.cssText = "border:0;background:none";
    li.textContent = code ? `Aucun ${M.un} confirmé dans ce territoire.` : `Aucun ${M.un} confirmé pour le moment.`;
    ul.appendChild(li);
    return;
  }

  for (const p of visibles) {
    const lycee = lyceeParUai(p.uai);
    const li = document.createElement("li");

    const nom = document.createElement("div");
    nom.className = "nom";
    nom.textContent = `${lycee.nom} (${lycee.ville})`;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent =
      `${motifParId(p.motif)?.label ?? p.motif} · signalé par ${appareils(p.confirmations)} · ` +
      depuis(Date.parse(p.dernier));

    li.append(nom, meta);
    // Un clic affiche la fiche du lycée en haut de l'onglet
    li.tabIndex = 0;
    li.style.cursor = "pointer";
    const ouvrir = () => montrerFicheRecherche(lycee);
    li.addEventListener("click", ouvrir);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter") ouvrir(); });
    ul.appendChild(li);
  }
}

/* ===================================================================
   BLOC JS 5 : LES STATISTIQUES ET LES GRAPHIQUES
   - Les chiffres "en direct" (liste, motifs, départements) sont calculés
     ici, à partir de la liste des lycées confirmés et de lycees.json.
   - Les chiffres historiques (jours, durée, record...) viennent de la
     fonction statistiques() de la base (schema-etape8.sql).
   Tous les graphiques sont de simples <div> : aucune bibliothèque.
   =================================================================== */

// Noms des départements (code à 3 caractères, comme dans lycees.json)
const DEPARTEMENTS = {
  "001":"Ain","002":"Aisne","003":"Allier","004":"Alpes-de-Haute-Provence","005":"Hautes-Alpes",
  "006":"Alpes-Maritimes","007":"Ardèche","008":"Ardennes","009":"Ariège","010":"Aube","011":"Aude",
  "012":"Aveyron","013":"Bouches-du-Rhône","014":"Calvados","015":"Cantal","016":"Charente",
  "017":"Charente-Maritime","018":"Cher","019":"Corrèze","02A":"Corse-du-Sud","02B":"Haute-Corse",
  "021":"Côte-d'Or","022":"Côtes-d'Armor","023":"Creuse","024":"Dordogne","025":"Doubs","026":"Drôme",
  "027":"Eure","028":"Eure-et-Loir","029":"Finistère","030":"Gard","031":"Haute-Garonne","032":"Gers",
  "033":"Gironde","034":"Hérault","035":"Ille-et-Vilaine","036":"Indre","037":"Indre-et-Loire",
  "038":"Isère","039":"Jura","040":"Landes","041":"Loir-et-Cher","042":"Loire","043":"Haute-Loire",
  "044":"Loire-Atlantique","045":"Loiret","046":"Lot","047":"Lot-et-Garonne","048":"Lozère",
  "049":"Maine-et-Loire","050":"Manche","051":"Marne","052":"Haute-Marne","053":"Mayenne",
  "054":"Meurthe-et-Moselle","055":"Meuse","056":"Morbihan","057":"Moselle","058":"Nièvre","059":"Nord",
  "060":"Oise","061":"Orne","062":"Pas-de-Calais","063":"Puy-de-Dôme","064":"Pyrénées-Atlantiques",
  "065":"Hautes-Pyrénées","066":"Pyrénées-Orientales","067":"Bas-Rhin","068":"Haut-Rhin","069":"Rhône",
  "070":"Haute-Saône","071":"Saône-et-Loire","072":"Sarthe","073":"Savoie","074":"Haute-Savoie",
  "075":"Paris","076":"Seine-Maritime","077":"Seine-et-Marne","078":"Yvelines","079":"Deux-Sèvres",
  "080":"Somme","081":"Tarn","082":"Tarn-et-Garonne","083":"Var","084":"Vaucluse","085":"Vendée",
  "086":"Vienne","087":"Haute-Vienne","088":"Vosges","089":"Yonne","090":"Territoire de Belfort",
  "091":"Essonne","092":"Hauts-de-Seine","093":"Seine-Saint-Denis","094":"Val-de-Marne","095":"Val-d'Oise",
  "971":"Guadeloupe","972":"Martinique","973":"Guyane","974":"La Réunion","975":"Saint-Pierre-et-Miquelon",
  "976":"Mayotte","977":"Saint-Barthélemy","978":"Saint-Martin","986":"Wallis-et-Futuna",
  "987":"Polynésie française","988":"Nouvelle-Calédonie",
};
const nomDepartement = (code) => DEPARTEMENTS[code] ?? code;

// Noms des régions (codes INSEE, comme le champ "reg" de lycees.json)
const REGIONS = {
  "11": "Île-de-France", "24": "Centre-Val de Loire", "27": "Bourgogne-Franche-Comté",
  "28": "Normandie", "32": "Hauts-de-France", "44": "Grand Est", "52": "Pays de la Loire",
  "53": "Bretagne", "75": "Nouvelle-Aquitaine", "76": "Occitanie", "84": "Auvergne-Rhône-Alpes",
  "93": "Provence-Alpes-Côte d'Azur", "94": "Corse", "01": "Guadeloupe", "02": "Martinique",
  "03": "Guyane", "04": "La Réunion", "06": "Mayotte", "00": "Autres territoires d'outre-mer",
};

// Petit raccourci : crée un élément avec du texte (jamais innerHTML)
function element(tag, texte, classe) {
  const e = document.createElement(tag);
  if (texte !== undefined) e.textContent = texte;
  if (classe) e.className = classe;
  return e;
}

const nombre = (n) => Number(n ?? 0).toLocaleString("fr-FR");

// Graphique VERTICAL. donnees = [{ valeur, etiquette, titre }]
// Seules les étiquettes non vides sont écrites sous l'axe (une sur trois
// par exemple), pour rester lisible sur téléphone.
function barresVerticales(idZone, donnees, description) {
  const zone = document.getElementById(idZone);
  zone.textContent = "";
  const max = Math.max(1, ...donnees.map((d) => d.valeur));

  const haut = element("div", `max : ${nombre(max)}`, "barres-max");
  const barres = element("div", undefined, "barres-zone");
  barres.setAttribute("role", "img");
  barres.setAttribute("aria-label", description);
  const axe = element("div", undefined, "barres-axe");

  for (const d of donnees) {
    const b = element("div", undefined, d.valeur === 0 ? "vide" : "");
    b.style.height = `${(d.valeur / max) * 100}%`;
    b.title = d.titre;
    barres.appendChild(b);
    axe.appendChild(element("span", d.etiquette ?? ""));
  }
  zone.append(haut, barres, axe);
}

// Graphique HORIZONTAL. lignes = [{ libelle, valeur, texte }]
function barresHorizontales(idZone, lignes, messageSiVide) {
  const zone = document.getElementById(idZone);
  zone.textContent = "";
  if (lignes.length === 0) { zone.appendChild(element("p", messageSiVide, "vide")); return; }

  const max = Math.max(...lignes.map((l) => l.valeur), 0) || 1;
  const ul = element("ul", undefined, "barres-h");
  for (const l of lignes) {
    const li = document.createElement("li");
    const piste = element("div", undefined, "piste");
    const plein = document.createElement("div");
    plein.style.width = `${(l.valeur / max) * 100}%`;
    piste.appendChild(plein);
    li.append(element("span", l.libelle), piste, element("span", l.texte, "valeur"));
    ul.appendChild(li);
  }
  zone.appendChild(ul);
}

// Durée lisible : 5 -> "5 h", 30 -> "1 j 6 h"
function duree(heures) {
  if (heures == null) return "–";
  const h = Math.round(heures);
  if (h < 24) return `${h} h`;
  return `${Math.floor(h / 24)} j${h % 24 ? ` ${h % 24} h` : ""}`;
}

// Mode du classement des départements : "nombre" ou "proportion"
let modeDepartements = "nombre";

function afficherStatistiques() {
  const visibles = perturbes.filter((p) => lyceeParUai(p.uai));

  // --- Chiffres clés ---------------------------------------------------
  document.getElementById("t-maintenant").textContent = nombre(visibles.length);
  document.getElementById("t-signalements").textContent = stats ? nombre(stats.signalements_aujourdhui) : "–";
  document.getElementById("t-confirmation").textContent =
    stats?.en_confirmation != null ? nombre(stats.en_confirmation) : "–";
  document.getElementById("t-nouveaux").textContent = stats ? nombre(stats.nouveaux_aujourdhui) : "–";
  document.getElementById("t-debloques").textContent = stats ? nombre(stats.debloques_aujourdhui) : "–";

  document.getElementById("t-duree").textContent = duree(stats?.duree_moyenne_heures);
  document.getElementById("t-duree-libelle").textContent = stats?.nb_blocages_termines
    ? `durée moyenne d'un blocage (${stats.nb_blocages_termines} terminé(s), 30 jours)`
    : "durée moyenne d'un blocage (pas encore de blocage terminé)";

  const record = stats?.record;
  document.getElementById("t-record").textContent = record ? nombre(record.nb) : "–";
  document.getElementById("t-record-libelle").textContent = record
    ? `record en même temps, le ${new Date(record.heure).toLocaleDateString("fr-FR",
        { day: "numeric", month: "long" })} à ${new Date(record.heure).getHours()} h`
    : `record ${M.deDes} perturbés en même temps`;

  // --- Heure par heure (24 h) -------------------------------------------
  barresVerticales("g-heures", historique.map((v, i) => {
    const h = new Date(v.heure).getHours();
    return {
      valeur: v.nb,
      etiquette: (i % 3 === 0 || i === historique.length - 1) ? `${h}h` : "",
      titre: `${h} h : ${v.nb} ${M.un}(s) perturbé(s)`,
    };
  }), `Nombre ${M.deDes} perturbés au cours des 24 dernières heures`);

  // --- Répartition par motif --------------------------------------------
  const parMotif = new Map();
  for (const p of visibles) parMotif.set(p.motif, (parMotif.get(p.motif) ?? 0) + 1);
  barresHorizontales("g-motifs",
    [...parMotif].sort((a, b) => b[1] - a[1]).map(([motif, n]) => ({
      libelle: motifParId(motif)?.label ?? motif,
      valeur: n,
      texte: `${n} (${Math.round((n / visibles.length) * 100)} %)`,
    })),
    `Aucun ${M.un} perturbé en ce moment.`);

  // --- Classement des départements --------------------------------------
  const totalParDept = new Map();      // nombre de lycées du département
  for (const l of LYCEES) totalParDept.set(l.dept, (totalParDept.get(l.dept) ?? 0) + 1);
  const perturbesParDept = new Map();  // nombre de lycées perturbés
  for (const p of visibles) {
    const d = lyceeParUai(p.uai).dept;
    perturbesParDept.set(d, (perturbesParDept.get(d) ?? 0) + 1);
  }
  const lignesDept = [...perturbesParDept].map(([d, n]) => {
    const total = totalParDept.get(d) ?? n;
    const part = (n / total) * 100;
    return {
      libelle: nomDepartement(d),
      valeur: modeDepartements === "nombre" ? n : part,
      texte: modeDepartements === "nombre"
        ? `${n} sur ${total}`
        : `${part.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} % (${n}/${total})`,
    };
  }).sort((a, b) => b.valeur - a.valeur).slice(0, 10);
  barresHorizontales("g-depts", lignesDept, "Aucun département concerné en ce moment.");

  // --- Public / privé et voies ------------------------------------------
  // On compare des PROPORTIONS : il y a bien plus de lycées publics que
  // privés, comparer des nombres n'aurait pas de sens.
  const perturbesUai = new Set(visibles.map((p) => p.uai));
  const ligneCategorie = (libelle, filtre) => {
    const groupe = LYCEES.filter(filtre);
    const n = groupe.filter((l) => perturbesUai.has(l.uai)).length;
    const part = groupe.length ? (n / groupe.length) * 100 : 0;
    return { libelle, valeur: part,
             texte: `${part.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} % (${n}/${groupe.length})` };
  };
  const aLesChamps = LYCEES.some((l) => l.statut);
  const aMettreAJour = `Disponible après la mise à jour de ${CONFIG.liste}.`;
  barresHorizontales("g-statut", aLesChamps ? [
    ligneCategorie("Public", (l) => l.statut === "public"),
    ligneCategorie("Privé", (l) => l.statut === "prive"),
  ] : [], aMettreAJour);
  // Les catégories (voies des lycées, types d'établissements du supérieur)
  // sont décrites dans CONFIG.categories : { code, libelle }. Un
  // établissement peut appartenir à plusieurs catégories.
  const champ = CONFIG.champCategories;
  barresHorizontales("g-voies", aLesChamps ? CONFIG.categories
    .map((c) => ligneCategorie(c.libelle, (l) => l[champ]?.includes(c.code)))
    .filter((ligne) => !ligne.texte.endsWith("/0)"))           // catégorie absente : pas de ligne
    : [], aMettreAJour);

  // --- Jour par jour (30 jours), pour la France ou une région -----------
  // Pour une région, on additionne ses départements (un lycée n'appartient
  // qu'à un département : pas de double compte).
  const regionJours = document.getElementById("choix-region-jours").value;
  let jours = stats?.par_jour ?? [];
  if (regionJours && stats?.par_jour_dept) {
    const regionDuDept = new Map(LYCEES.map((l) => [l.dept, l.reg]));
    const parJour = new Map(jours.map((j) => [j.jour, 0]));
    for (const d of stats.par_jour_dept) {
      if (regionDuDept.get(d.dept) === regionJours && parJour.has(d.jour)) {
        parJour.set(d.jour, parJour.get(d.jour) + d.nb);
      }
    }
    jours = [...parJour].map(([jour, nb]) => ({ jour, nb }));
  }
  if (jours.length) {
    barresVerticales("g-jours", jours.map((j, i) => {
      const date = new Date(j.jour + "T12:00:00");
      const court = date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
      return {
        valeur: j.nb,
        etiquette: (i % 5 === 0 || i === jours.length - 1) ? court : "",
        titre: `${date.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })} : ${j.nb} ${M.un}(s)`,
      };
    }), `Nombre ${M.deDes} perturbés chaque jour sur 30 jours`);
  } else {
    document.getElementById("g-jours").textContent = "Statistiques indisponibles pour le moment.";
  }

  // --- Heures de signalement --------------------------------------------
  const heures = stats?.heures_signalement ?? [];
  if (heures.length) {
    barresVerticales("g-heures-signalement", heures.map((n, h) => ({
      valeur: n,
      etiquette: h % 3 === 0 ? `${h}h` : "",
      titre: `Entre ${h} h et ${h + 1} h : ${nombre(n)} signalement(s)`,
    })), "Nombre de signalements selon l'heure de la journée");
  } else {
    document.getElementById("g-heures-signalement").textContent = "Statistiques indisponibles pour le moment.";
  }
  majTextesReglages();
}

// Les textes qui citent le seuil ou la durée de validité (classes
// "txt-seuil" et "txt-expiration" dans la page) sont mis à jour avec les
// valeurs réelles de la base : ils restent justes si tu changes les réglages.
function majTextesReglages() {
  if (!stats?.seuil) return;
  const seuil = stats.seuil === 1 ? "un seul appareil" : `au moins ${stats.seuil} appareils différents`;
  for (const e of document.querySelectorAll(".txt-seuil")) e.textContent = seuil;
  for (const e of document.querySelectorAll(".txt-expiration")) e.textContent = `${stats.expiration_heures} heures`;
}

// Boutons "En nombre" / "En proportion"
for (const mode of ["nombre", "proportion"]) {
  document.getElementById("mode-" + mode).addEventListener("click", () => {
    modeDepartements = mode;
    document.getElementById("mode-nombre").setAttribute("aria-pressed", String(mode === "nombre"));
    document.getElementById("mode-proportion").setAttribute("aria-pressed", String(mode === "proportion"));
    document.getElementById("g-depts-aide").textContent = mode === "nombre"
      ? `Nombre ${M.deDes} perturbés par département`
      : `Part des ${M.des} du département qui sont perturbés`;
    afficherStatistiques();
  });
}

/* ===================================================================
   BLOC JS 6 : LE MENU DES MOTIFS
   Il est construit automatiquement depuis MOTIFS : c'est ce qui permet
   d'ajouter un motif en ne touchant qu'une seule ligne de la config.
   =================================================================== */
function remplirMotifs() {
  const select = document.getElementById("motif");
  for (const m of MOTIFS.filter((m) => m.actif)) {
    const option = document.createElement("option");
    option.value = m.id;
    option.textContent = m.label;
    select.appendChild(option);
  }
}

/* ===================================================================
   BLOC JS 7 : L'AUTOCOMPLÉTION
   À chaque lettre tapée :
   1. on normalise le texte saisi
   2. on garde les lycées dont le nom ou la ville le contiennent
   3. on affiche les premiers (8, ou CONFIG.nbSuggestions)
   Les flèches ↑ ↓ et Entrée fonctionnent aussi au clavier.
   La fonction autocompletion() sert pour les deux champs de recherche
   du site (onglet Signaler et onglet Liste).
   =================================================================== */
function chercher(texte) {
  const q = normaliser(texte.trim());
  if (q.length < 2) return [];                       // on attend 2 lettres
  return LYCEES.filter((l) => l.recherche.includes(q)).slice(0, CONFIG.nbSuggestions ?? 8);
}

// input : le champ ; boite : la liste <ul> des suggestions ;
// quandChoisi(lycee) : ce qu'on fait quand un lycée est choisi
function autocompletion(input, boite, quandChoisi) {
  let resultats = [];       // lycées actuellement suggérés
  let indexActif = -1;      // suggestion surlignée au clavier

  function afficher() {
    boite.textContent = "";
    resultats.forEach((l, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      if (i === indexActif) li.className = "actif";
      li.append(l.nom + " ");
      const small = document.createElement("small");
      small.textContent = `${l.ville} (${nomDepartement(l.dept)})`;
      li.appendChild(small);
      // mousedown (et non click) : se déclenche avant que le champ perde le focus
      li.addEventListener("mousedown", (e) => { e.preventDefault(); choisir(l); });
      boite.appendChild(li);
    });
    boite.hidden = resultats.length === 0;
    input.setAttribute("aria-expanded", String(!boite.hidden));
  }

  function choisir(l) {
    resultats = [];
    afficher();
    input.value = `${l.nom} (${l.ville})`;
    quandChoisi(l);
  }

  input.addEventListener("input", () => {
    resultats = chercher(input.value);
    indexActif = -1;
    afficher();
  });
  input.addEventListener("keydown", (e) => {
    if (resultats.length === 0) return;
    if (e.key === "ArrowDown") { indexActif = (indexActif + 1) % resultats.length; e.preventDefault(); }
    else if (e.key === "ArrowUp") { indexActif = (indexActif - 1 + resultats.length) % resultats.length; e.preventDefault(); }
    else if (e.key === "Enter" && indexActif >= 0) { choisir(resultats[indexActif]); e.preventDefault(); return; }
    else if (e.key === "Escape") { resultats = []; }
    afficher();
  });
  input.addEventListener("blur", () => { boite.hidden = true; });

  return { choisir, vider() { resultats = []; afficher(); input.value = ""; } };
}

// Le champ de l'onglet Signaler
const champ = document.getElementById("champ");
let lyceeChoisi = null;   // lycée finalement sélectionné
const autoSignaler = autocompletion(champ, document.getElementById("suggestions"), (l) => choisir(l));

function choisir(lycee) {
  lyceeChoisi = lycee;
  champ.value = `${lycee.nom} (${lycee.ville})`;
  document.getElementById("lycee-choisi").textContent = lycee.nom + " – " + lycee.ville;
  document.getElementById("volet").hidden = false;   // on ouvre le volet d'action
  majBoutonMonLycee();
  afficherCaptcha();
  document.getElementById("message").textContent = "";
}

champ.addEventListener("input", () => {
  lyceeChoisi = null;
  document.getElementById("volet").hidden = true;    // on referme si on retape
});

/* ===================================================================
   BLOC JS 8 : LE BOUTON VALIDER
   On AJOUTE un événement au journal de la base (on ne modifie rien).
   La base peut refuser l'envoi (limites, appareil invalide) : on
   traduit alors son code d'erreur en message lisible.
   =================================================================== */
const MESSAGES_ERREUR = {
  limite_atteinte: "Tu as déjà envoyé plusieurs signalements récemment. Réessaie dans une heure.",
  appareil_invalide: "Ton navigateur bloque le stockage local : impossible d'envoyer un signalement.",
  motif_invalide: "Ce motif n'est plus disponible. Recharge la page.",
  captcha_invalide: "La vérification anti-robot a échoué. Réessaie dans quelques secondes.",
  lycee_inconnu: `${M.Ce} est introuvable. Recharge la page.`,
  service_en_pause: "Les signalements sont temporairement suspendus. Réessaie plus tard.",
};

document.getElementById("valider").addEventListener("click", async () => {
  if (!lyceeChoisi) return;
  if (servicePause) {
    const m = document.getElementById("message");
    m.style.color = "var(--alerte)";
    m.textContent = MESSAGES_ERREUR.service_en_pause;
    return;
  }
  const uai = lyceeChoisi.uai;
  const motifId = document.getElementById("motif").value;
  const bouton = document.getElementById("valider");
  const message = document.getElementById("message");
  if (!jetonCaptcha) {
    message.style.color = "var(--alerte)";
    message.textContent = "Vérification anti-robot en cours : patiente quelques secondes, puis réessaie.";
    return;
  }
  bouton.disabled = true;                 // évite le double clic
  try {
    // L'envoi passe par la fonction "signaler" : elle fait vérifier le
    // CAPTCHA par Cloudflare avant d'enregistrer quoi que ce soit.
    const reponse = await fetch(`${SUPABASE_URL}/functions/v1/signaler`, {
      method: "POST",
      headers: { apikey: SUPABASE_CLE, "Content-Type": "application/json" },
      body: JSON.stringify({ uai, motif: motifId, appareil: idAppareil(), captcha: jetonCaptcha }),
    });
    const donnees = await reponse.json().catch(() => ({}));
    if (!reponse.ok) throw new Error(donnees.erreur || `http_${reponse.status}`);
    await chargerEtat();                  // on recharge pour voir le résultat
    rafraichir();
    message.style.color = "";
    // Texte de confirmation : il dépend de l'état du lycée après le signalement
    const dansLaListe = perturbes.some((p) => p.uai === uai);
    let detail;
    if (!motifParId(motifId)?.perturbe) detail = "Merci de nous avoir informés du retour à la normale.";
    else if (dansLaListe) detail = `${M.Ce} figure dans la liste des ${M.des} perturbés.`;
    else detail = `Il apparaîtra dans la liste dès qu'il aura été confirmé par d'autres ${M.personnes}.`;
    message.textContent = "";
    const l = lyceeParUai(uai);
    afficherConfirmation(`${l.nom} (${l.ville})`, detail);
  } catch (e) {
    console.error(e);
    const code = Object.keys(MESSAGES_ERREUR).find((c) => String(e.message).includes(c));
    message.style.color = "var(--alerte)";
    message.textContent = code ? MESSAGES_ERREUR[code] : "L'envoi a échoué. Réessaie dans un instant.";
  } finally {
    bouton.disabled = false;
    reinitialiserCaptcha();               // nouveau jeton pour le prochain envoi
  }
});

/* ===================================================================
   BLOC JS 8b : ONGLETS ET MESSAGE DE CONFIRMATION
   - ouvrirOnglet() affiche une section et cache les autres.
   - L'onglet actif est inscrit dans l'adresse (#signaler, #stats,
     #carte) : on peut partager un onglet et le bouton "retour" marche.
   =================================================================== */
const ONGLETS = ["signaler", "stats", "carte", "infos"];

// L'adresse peut aussi viser un élément précis (liens partageables) :
//   #stats/lycee/0690521S        -> fiche du lycée dans l'onglet Liste
//                                   ("etablissement" au lieu de "lycee" côté universités)
//   #carte/region/84             -> une région sur la carte
//   #carte/departement/069       -> un département sur la carte
//   #carte/lycee/0690521S        -> un lycée sur la carte
//   #infos/faq                   -> une partie de l'onglet Méthode et à propos
function lireAdresse() {
  const [onglet, type, code] = decodeURIComponent(location.hash.slice(1)).split("/");
  return { onglet, route: type && code ? { type, code } : null };
}

function ouvrirOnglet(nom, route = null) {
  if (!ONGLETS.includes(nom)) nom = "signaler";        // adresse inconnue : onglet 1
  if (nom === "carte") ouvrirCarte(route);             // la carte est créée à la première ouverture
  if (nom === "stats" && route?.type === ROUTE) ouvrirFicheDepuisAdresse(route.code);
  for (const o of ONGLETS) {
    document.getElementById("onglet-" + o).hidden = (o !== nom);
    const bouton = document.getElementById("bouton-" + o);
    bouton.setAttribute("aria-selected", String(o === nom));
    bouton.tabIndex = (o === nom) ? 0 : -1;
  }
  // Onglet Méthode : on fait défiler jusqu'à la partie demandée (#infos/faq)
  if (nom === "infos") {
    const partie = decodeURIComponent(location.hash).split("/")[1];
    const titre = partie && document.getElementById("infos-" + partie);
    if (titre) titre.scrollIntoView({ block: "start" });
    else window.scrollTo(0, 0);
  }
}

for (const o of ONGLETS) {
  const bouton = document.getElementById("bouton-" + o);
  bouton.addEventListener("click", () => { location.hash = o; });
  // Flèches gauche/droite : passer d'un onglet à l'autre au clavier
  bouton.addEventListener("keydown", (e) => {
    const i = ONGLETS.indexOf(o);
    if (e.key === "ArrowRight") location.hash = ONGLETS[(i + 1) % ONGLETS.length];
    else if (e.key === "ArrowLeft") location.hash = ONGLETS[(i + ONGLETS.length - 1) % ONGLETS.length];
    else return;
    document.getElementById("bouton-" + location.hash.slice(1))?.focus();
  });
}
window.addEventListener("hashchange", () => { const a = lireAdresse(); ouvrirOnglet(a.onglet, a.route); });
// À l'ouverture de la page : setTimeout pour que tout le script soit lu
setTimeout(() => { const a = lireAdresse(); ouvrirOnglet(a.onglet, a.route); }, 0);

// Affiche le grand message "Votre signalement a été émis" à la place du formulaire
function afficherConfirmation(nomLycee, detail) {
  document.querySelector("#confirmation-lycee strong").textContent = nomLycee;
  document.getElementById("confirmation-detail").textContent = detail;
  document.getElementById("formulaire").hidden = true;
  const boite = document.getElementById("confirmation");
  boite.hidden = false;
  boite.focus();                                        // lecteurs d'écran : annonce le message
}

// Revient au formulaire vide pour un nouveau signalement
document.getElementById("autre").addEventListener("click", () => {
  lyceeChoisi = null;
  autoSignaler.vider();
  document.getElementById("volet").hidden = true;
  document.getElementById("message").textContent = "";
  document.getElementById("confirmation").hidden = true;
  document.getElementById("formulaire").hidden = false;
  champ.focus();
});

document.getElementById("voir-liste").addEventListener("click", () => { location.hash = "stats"; });

/* ===================================================================
   BLOC JS 10 : LA CARTE, EN TROIS NIVEAUX
     1. France     : les régions, colorées selon les lycées perturbés
     2. Région     : ses départements, même coloration
     3. Département: un point par lycée, sur le fond de carte de l'IGN
                     (rues, villes), avec un zoom jusqu'au niveau des rues
   - Contours : carte-regions.geojson et carte-departements.geojson
     (IGN Admin Express, Licence Ouverte), à côté de index.html.
     Celui des départements n'est chargé qu'au premier clic sur une région.
   - Fond de carte : Plan IGN (Géoplateforme, Licence Ouverte), chargé
     seulement au niveau 3. Aucune clé n'est nécessaire.
   - Les totaux sont calculés ici, en croisant la liste des lycées
     confirmés avec lycees.json (champs "reg", "dept", "lat", "lon").
   =================================================================== */

const OUTRE_MER = ["01", "02", "03", "04", "06"];   // régions = départements uniques
const DEPT_OUTRE_MER = { "01": "971", "02": "972", "03": "973", "04": "974", "06": "976" };

// Couleurs des zones : du plus clair (aucun lycée) au plus foncé
const COULEURS = ["#eef1f4", "#fde9e2", "#f9b9a3", "#f08562", "#d4380d", "#8f2306"];
// Seuils : une zone va dans la classe i si valeur >= SEUILS[mode][i]
const SEUILS = {
  nombre:     [0, 1, 3, 6, 11, 21],          // nombre de lycées perturbés
  proportion: [0, 0.01, 1, 2, 5, 10],         // % des lycées de la zone
};
const LIBELLES_LEGENDE = {
  nombre:     ["aucun", "1 à 2", "3 à 5", "6 à 10", "11 à 20", "21 et plus"],
  proportion: ["0 %", "moins de 1 %", "1 à 2 %", "2 à 5 %", "5 à 10 %", "10 % et plus"],
};

// Couleurs des points (niveau 3), selon le motif. Un nouveau motif
// ajouté dans la base prend la couleur "autre".
const COULEURS_MOTIFS = { bloque: "#d4380d", police: "#6d28d9", partiel: "#e8930c", autre: "#d4380d" };
const COULEUR_CALME = "#5d6b78";             // lycée sans perturbation

// Écran tactile sans souris (téléphone) : pas de bulles de survol, le
// toucher ouvre directement le niveau suivant ou la fiche du lycée
const SURVOL_POSSIBLE = window.matchMedia("(hover: hover)").matches;

// Fond de carte Plan IGN (Géoplateforme)
const URL_FOND = "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0" +
  "&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/png" +
  "&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}";

let carte = null;            // l'objet Leaflet, créé à la première ouverture
let coucheRegions = null;    // contours des régions
let coucheDepts = null;      // contours des départements de la région ouverte
let couchePoints = null;     // les points des lycées (niveau 3)
let coucheFond = null;       // le fond de carte IGN (niveau 3)
let contours = null;         // contenu de carte-regions.geojson
let contoursDepts = null;    // contenu de carte-departements.geojson
let modeCarte = "nombre";
let regionOuverte = null;    // niveau 2 ou 3 en métropole : code de la région
let deptOuvert = null;       // niveau 3 : code du département (ex. "069", "971")
let outreMerOuvert = null;   // niveau 3 en outre-mer : code de la région (ex. "01")
let selection = null;        // zone du panneau "Détail" : { type: "region" | "dept", code }

/* --- Calculs ------------------------------------------------------ */

// Totaux par zone. champ = "reg" ou "dept".
// Renvoie une Map : code -> { total, perturbes: [{ lycee, motif }] }
function totauxPar(champ) {
  const t = new Map();
  for (const l of LYCEES) {
    const code = l[champ];
    if (!code) continue;
    if (!t.has(code)) t.set(code, { total: 0, perturbes: [] });
    t.get(code).total++;
  }
  for (const p of perturbes) {
    const l = lyceeParUai(p.uai);
    const code = l?.[champ];
    if (code && t.has(code)) t.get(code).perturbes.push({ lycee: l, motif: p.motif });
  }
  return t;
}

const champDe = (type) => (type === "dept" ? "dept" : "reg");
const infoZone = (zone) => totauxPar(champDe(zone.type)).get(zone.code) ?? { total: 0, perturbes: [] };

function valeur(info) {
  if (!info) return 0;
  const n = info.perturbes.length;
  return modeCarte === "nombre" ? n : (info.total ? (n / info.total) * 100 : 0);
}

function couleurPour(v) {
  const seuils = SEUILS[modeCarte];
  let classe = 0;
  for (let i = 1; i < seuils.length; i++) if (v > 0 && v >= seuils[i]) classe = i;
  return COULEURS[classe];
}

function nomRegion(code) {
  const f = contours?.features.find((x) => x.properties.code === code);
  return f?.properties.nom ?? REGIONS[code] ?? `Région ${code}`;
}
const nomZone = (zone) => (zone.type === "dept" ? nomDepartement(zone.code) : nomRegion(zone.code));

const pourcent = (n, total) =>
  total ? (n / total * 100).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " %" : "0 %";

const estSelectionne = (type, code) => selection?.type === type && selection.code === code;

/* --- Apparence des zones ------------------------------------------ */

const INVISIBLE = { fillOpacity: 0, opacity: 0 };

function styleRegion(feature, totaux) {
  const code = feature.properties.code;
  // Niveau 3 : la région ouverte laisse place à ses départements ; le
  // territoire d'outre-mer ouvert n'a qu'un contour ; tout le reste est
  // voilé de blanc pour mettre en valeur la zone ouverte
  if (deptOuvert) {
    if (code === outreMerOuvert) return { fillOpacity: 0, color: "#17212b", weight: 2.5, opacity: 1 };
    if (code === regionOuverte) return INVISIBLE;
    return { fillColor: "#ffffff", fillOpacity: 0.55, color: "#8a96a3", weight: 1, opacity: 1 };
  }
  // Niveau 2 : la région ouverte est cachée (ses départements sont dessinés
  // par-dessus), les autres sont estompées avec un contour gris
  if (code === regionOuverte) return INVISIBLE;
  if (regionOuverte) {
    return { fillColor: couleurPour(valeur(totaux.get(code))), fillOpacity: 0.4,
             color: "#aab5c0", weight: 1, opacity: 1 };
  }
  // Niveau 1
  return {
    fillColor: couleurPour(valeur(totaux.get(code))),
    fillOpacity: 1,
    color: estSelectionne("region", code) ? "#17212b" : "#ffffff",
    weight: estSelectionne("region", code) ? 2.5 : 1,
    opacity: 1,
  };
}

function styleDept(feature, totaux) {
  const code = feature.properties.code;
  // Niveau 3 : le département ouvert est transparent (on voit le fond de
  // carte), ses voisins sont voilés de blanc et restent cliquables
  if (deptOuvert) {
    return code === deptOuvert
      ? { fillOpacity: 0, color: "#17212b", weight: 2.5, opacity: 1 }
      : { fillColor: "#ffffff", fillOpacity: 0.55, color: "#8a96a3", weight: 1, opacity: 1 };
  }
  return {
    fillColor: couleurPour(valeur(totaux.get(code))),
    fillOpacity: 1,
    color: estSelectionne("dept", code) ? "#17212b" : "#ffffff",
    weight: estSelectionne("dept", code) ? 2.5 : 1,
    opacity: 1,
  };
}

// Une zone peut être rendue insensible à la souris (zone cachée, ou zone
// ouverte : on veut alors survoler les points, pas le contour)
function activerSouris(couche, actif) {
  const el = couche.getElement();
  if (el) el.style.pointerEvents = actif ? "" : "none";
}

// Recolore la carte (appelée aussi toutes les 30 s par rafraichir())
function mettreAJourCarte() {
  if (!coucheRegions) return;
  const parRegion = totauxPar("reg");
  coucheRegions.eachLayer((c) => {
    c.setStyle(styleRegion(c.feature, parRegion));
    activerSouris(c, !deptOuvert && c.feature.properties.code !== regionOuverte);
  });
  const parDept = totauxPar("dept");
  coucheDepts.eachLayer((c) => {
    c.setStyle(styleDept(c.feature, parDept));
    activerSouris(c, c.feature.properties.code !== deptOuvert);
  });
  if (deptOuvert) dessinerPoints();
  afficherLegende();
  if (selection) afficherDetail(selection);
}

function afficherLegende() {
  const zone = document.getElementById("carte-legende");
  zone.textContent = "";
  if (deptOuvert) {
    // Niveau 3 : légende des points
    const elements = [[`${M.un} sans signalement confirmé`, COULEUR_CALME]];
    for (const m of MOTIFS.filter((m) => m.perturbe)) {
      elements.push([m.label, COULEURS_MOTIFS[m.id] ?? COULEURS_MOTIFS.autre]);
    }
    for (const [texte, couleur] of elements) {
      const s = element("span", texte, "rond");
      s.style.setProperty("--c", couleur);
      zone.appendChild(s);
    }
    return;
  }
  LIBELLES_LEGENDE[modeCarte].forEach((texte, i) => {
    const s = element("span", texte);
    s.style.setProperty("--c", COULEURS[i]);
    zone.appendChild(s);
  });
}

/* --- Bulles et panneau "Détail" ----------------------------------- */

// Bulle d'une région ou d'un département (éléments + textContent : pas d'innerHTML)
function bulle(zone) {
  const info = infoZone(zone);
  const n = info.perturbes.length;
  const div = element("div", undefined, "bulle");
  div.appendChild(element("strong", nomZone(zone)));
  div.appendChild(element("span",
    `${n} ${M.un}(s) perturbé(s) sur ${info.total} (${pourcent(n, info.total)})`));
  if (n) {
    const ul = document.createElement("ul");
    for (const p of info.perturbes.slice(0, 5)) {
      ul.appendChild(element("li", `${p.lycee.nom} (${p.lycee.ville})`));
    }
    if (n > 5) ul.appendChild(element("li", `et ${n - 5} autre(s)…`));
    div.appendChild(ul);
  }
  const aide = zone.type === "dept" ? `Cliquer pour voir les ${M.des} sur la carte`
             : OUTRE_MER.includes(zone.code) ? `Cliquer pour voir les ${M.des} sur la carte`
             : "Cliquer pour voir les départements";
  div.appendChild(element("em", aide));
  return div;
}

// Bulle d'un lycée (niveau 3)
function bulleLycee(lycee, p) {
  const div = element("div", undefined, "bulle");
  div.appendChild(element("strong", lycee.nom));
  div.appendChild(element("span", lycee.ville));
  if (p) {
    div.appendChild(element("div", motifParId(p.motif)?.label ?? p.motif, "bulle-motif"));
    div.appendChild(element("em",
      `${p.confirmations} confirmation(s) · dernier signalement ${depuis(Date.parse(p.dernier))}`));
  } else {
    div.appendChild(element("em", "Aucun signalement confirmé"));
  }
  return div;
}

function afficherDetail(zone) {
  selection = zone;
  const info = infoZone(zone);
  const n = info.perturbes.length;
  document.getElementById("detail-titre").textContent = nomZone(zone);
  document.getElementById("detail-resume").textContent =
    `${n} ${M.un}(s) perturbé(s) sur ${info.total} (${pourcent(n, info.total)})`;

  const ul = document.getElementById("detail-liste");
  ul.textContent = "";
  if (!n) { ul.appendChild(element("li", `Aucun ${M.un} perturbé en ce moment.`, "vide")); return; }
  const tries = [...info.perturbes].sort((a, b) =>
    a.lycee.ville.localeCompare(b.lycee.ville, "fr") || a.lycee.nom.localeCompare(b.lycee.nom, "fr"));
  for (const p of tries) {
    const li = element("li", p.lycee.nom + " ");
    const lieu = zone.type === "dept" ? p.lycee.ville : `${p.lycee.ville} (${nomDepartement(p.lycee.dept)})`;
    li.appendChild(element("small", `${lieu} · ${motifParId(p.motif)?.label ?? p.motif}`));
    // Au niveau 3, un clic dans la liste centre la carte sur le lycée
    if (deptOuvert && p.lycee.lat != null && p.lycee.lon != null) {
      li.classList.add("cliquable");
      li.tabIndex = 0;
      const viser = () => viserLycee(p.lycee.uai);
      li.addEventListener("click", viser);
      li.addEventListener("keydown", (e) => { if (e.key === "Enter") viser(); });
    }
    ul.appendChild(li);
  }
}

function effacerDetail() {
  selection = null;
  document.getElementById("detail-titre").textContent = "Détail";
  document.getElementById("detail-resume").textContent = "Choisissez une région sur la carte.";
  document.getElementById("detail-liste").textContent = "";
}

/* --- Les points des lycées (niveau 3) ------------------------------ */

const marqueurs = new Map();   // uai -> point, pour viserLycee()

function dessinerPoints() {
  // Fiche ouverte avant la mise à jour : on la rouvrira après
  let ouvert = null;
  for (const [uai, m] of marqueurs) if (m.isPopupOpen()) ouvert = uai;
  couchePoints.clearLayers();
  marqueurs.clear();
  const etat = new Map(perturbes.map((p) => [p.uai, p]));
  const lycees = LYCEES.filter((l) => l.dept === deptOuvert && l.lat != null && l.lon != null);
  // Les lycées calmes d'abord, pour que les points perturbés passent au-dessus
  lycees.sort((a, b) => Number(etat.has(a.uai)) - Number(etat.has(b.uai)));
  for (const l of lycees) {
    const p = etat.get(l.uai);
    const point = L.circleMarker([l.lat, l.lon], {
      pane: "points",
      radius: p ? 8 : 5,
      color: "#ffffff", weight: p ? 2 : 1.5,
      fillColor: p ? (COULEURS_MOTIFS[p.motif] ?? COULEURS_MOTIFS.autre) : COULEUR_CALME,
      fillOpacity: p ? 1 : 0.75,
    });
    if (SURVOL_POSSIBLE) point.bindTooltip(() => bulleLycee(l, p), { direction: "top", offset: [0, -6] });
    // Un clic (ou un toucher sur téléphone) ouvre une fiche qui reste affichée
    point.bindPopup(() => ficheLycee(l, { surCarte: true }), { offset: [0, -4], maxWidth: 300 });
    point.on("popupopen", () => { point.closeTooltip(); majAdresse(l.uai); });
    point.on("popupclose", () => majAdresse());
    point.addTo(couchePoints);
    marqueurs.set(l.uai, point);
  }
  if (ouvert) marqueurs.get(ouvert)?.openPopup();
}

function viserLycee(uai) {
  const point = marqueurs.get(uai);
  if (!point) return;
  carte.setView(point.getLatLng(), Math.max(carte.getZoom(), 14), { animate: false });
  point.openPopup();
  document.getElementById("carte-france").scrollIntoView({ behavior: "smooth", block: "center" });
}

/* --- Navigation entre les niveaux --------------------------------- */

// Fil d'Ariane au-dessus de la carte
function afficherFil() {
  // visibility (et non hidden) : la place reste réservée, la carte ne
  // saute pas quand le fil apparaît
  majAdresse();
  const visible = Boolean(regionOuverte || deptOuvert);
  document.getElementById("carte-fil").style.visibility = visible ? "visible" : "hidden";
  if (!visible) return;
  const parties = [];
  if (regionOuverte) parties.push(nomRegion(regionOuverte));
  if (outreMerOuvert) parties.push(nomRegion(outreMerOuvert));
  else if (deptOuvert) parties.push(nomDepartement(deptOuvert));
  document.getElementById("carte-fil-nom").textContent = parties.join(" › ");
  document.getElementById("carte-retour").textContent =
    deptOuvert && regionOuverte ? `← ${nomRegion(regionOuverte)}` : "← France";
}

// Inscrit la vue actuelle dans l'adresse (#carte/departement/069...), sans
// créer d'entrée dans l'historique : "Copier le lien" partage ce qu'on voit.
function majAdresse(uaiLycee = null) {
  if (!location.hash.startsWith("#carte")) return;     // on n'est pas sur la carte
  let suite = "";
  if (uaiLycee) suite = `/${ROUTE}/` + uaiLycee;
  else if (outreMerOuvert) suite = "/region/" + outreMerOuvert;
  else if (deptOuvert) suite = "/departement/" + deptOuvert;
  else if (regionOuverte) suite = "/region/" + regionOuverte;
  history.replaceState(null, "", "#carte" + suite);
}

// Ouvre la carte sur l'élément visé par un lien partagé
async function appliquerRouteCarte(route) {
  const { type, code } = route;
  if (type === "region") {
    if (OUTRE_MER.includes(code) || code === "00") afficherTerritoire(code);
    else if (REGIONS[code]) await entrerRegion(code);
    return;
  }
  // Département ou lycée : on retrouve le département, puis sa région
  let dept = code, uai = null;
  if (type === ROUTE) {
    const l = lyceeParUai(code);
    if (!l) return;
    dept = l.dept; uai = l.uai;
  }
  const om = Object.keys(DEPT_OUTRE_MER).find((r) => DEPT_OUTRE_MER[r] === dept);
  if (om) afficherTerritoire(om);
  else {
    await chargerDepartements();
    const f = contoursDepts.features.find((x) => x.properties.code === dept);
    if (!f) {                                          // pas de contour (ex. Polynésie)
      afficherTerritoire("00");
      return;
    }
    await entrerRegion(f.properties.reg);
    entrerDepartement(dept);
  }
  if (uai) viserLycee(uai);
}

// Survol : contour foncé ; sortie : style normal.
// "survolee" garde la zone survolée : si le navigateur oublie de signaler
// la sortie (souris très rapide), on la remet en état au survol suivant.
let survolee = null;
function survol(couche, styleFn, parFn) {
  couche.on("mouseover", () => {
    if (survolee && survolee !== couche) survolee.fire("mouseout");
    survolee = couche;
    couche.setStyle({ weight: 2.5, color: "#17212b", opacity: 1 });
    couche.bringToFront();
  });
  couche.on("mouseout", () => {
    couche.setStyle(styleFn(couche.feature, parFn()));
    couche.closeTooltip();
    if (survolee === couche) survolee = null;
  });
}

async function chargerDepartements() {
  if (contoursDepts) return;
  const reponse = await fetch("carte-departements.geojson");
  if (!reponse.ok) throw new Error("carte-departements.geojson introuvable");
  contoursDepts = await reponse.json();
}

// Le fond de carte n'est affiché qu'au niveau 3
function fondDeCarte(visible) {
  if (visible && !carte.hasLayer(coucheFond)) coucheFond.addTo(carte);
  if (!visible && carte.hasLayer(coucheFond)) carte.removeLayer(coucheFond);
}

// Niveau 2 : on entre dans une région de métropole
async function entrerRegion(code) {
  try { await chargerDepartements(); }
  catch (e) { console.error(e); afficherDetail({ type: "region", code }); return; }

  regionOuverte = code;
  deptOuvert = null;
  fondDeCarte(false);
  couchePoints.clearLayers();
  coucheDepts.clearLayers();
  coucheDepts.addData({
    type: "FeatureCollection",
    features: contoursDepts.features.filter((f) => f.properties.reg === code),
  });
  coucheDepts.bringToFront();
  carte.fitBounds(coucheDepts.getBounds(), { padding: [20, 20] });
  selection = { type: "region", code };
  afficherFil();
  mettreAJourCarte();
}

// Niveau 3 en métropole : on entre dans un département
function entrerDepartement(code) {
  let couche = null;
  coucheDepts.eachLayer((c) => { if (c.feature.properties.code === code) couche = c; });
  if (!couche) return;
  deptOuvert = code;
  fondDeCarte(true);
  carte.fitBounds(couche.getBounds(), { padding: [20, 20] });
  selection = { type: "dept", code };
  afficherFil();
  mettreAJourCarte();
}

// Niveau 3 en outre-mer : le territoire est à la fois région et département
function entrerOutreMer(code) {
  let couche = null;
  coucheRegions.eachLayer((c) => { if (c.feature.properties.code === code) couche = c; });
  regionOuverte = null;
  coucheDepts.clearLayers();
  outreMerOuvert = code;
  deptOuvert = DEPT_OUTRE_MER[code];
  fondDeCarte(true);
  if (couche) carte.fitBounds(couche.getBounds(), { padding: [20, 20] });
  selection = { type: "region", code };
  afficherFil();
  mettreAJourCarte();
}

// Retour au niveau 1 (France métropolitaine)
function revenirFrance() {
  regionOuverte = null;
  deptOuvert = null;
  outreMerOuvert = null;
  fondDeCarte(false);
  couchePoints.clearLayers();
  coucheDepts.clearLayers();
  afficherFil();
  effacerDetail();
}

// Bouton "←" : remonte d'un niveau
function remonter() {
  if (deptOuvert && regionOuverte) {        // département -> sa région
    const r = regionOuverte;
    deptOuvert = null;
    fondDeCarte(false);
    couchePoints.clearLayers();
    carte.fitBounds(coucheDepts.getBounds(), { padding: [20, 20] });
    selection = { type: "region", code: r };
    afficherFil();
    mettreAJourCarte();
  } else {
    afficherTerritoire("metropole");
  }
}

// Boutons du haut : "metropole", un territoire d'outre-mer, ou "00"
function afficherTerritoire(territoire) {
  for (const b of document.querySelectorAll("#choix-territoire button")) {
    b.setAttribute("aria-pressed", String(b.dataset.territoire === territoire));
  }
  revenirFrance();
  if (OUTRE_MER.includes(territoire)) { entrerOutreMer(territoire); return; }
  // Les collectivités d'outre-mer (code 00) n'ont pas de contours : liste seule
  if (territoire === "00") {
    afficherDetail({ type: "region", code: "00" });
    mettreAJourCarte();
    document.getElementById("carte-detail").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const couches = [];
  coucheRegions.eachLayer((c) => { if (!OUTRE_MER.includes(c.feature.properties.code)) couches.push(c); });
  carte.fitBounds(L.featureGroup(couches).getBounds(), { padding: [10, 10] });
  mettreAJourCarte();
}

/* --- Création de la carte ----------------------------------------- */

async function creerCarte() {
  const reponse = await fetch("carte-regions.geojson");
  if (!reponse.ok) throw new Error("carte-regions.geojson introuvable");
  contours = await reponse.json();

  carte = L.map("carte-france", { zoomSnap: 0.25, minZoom: 3, maxZoom: 18 });
  carte.attributionControl.setPrefix(false);
  carte.attributionControl.addAttribution("Contours : IGN Admin Express (Licence Ouverte)");

  // Calque réservé aux points, au-dessus des contours
  carte.createPane("points").style.zIndex = 450;

  coucheFond = L.tileLayer(URL_FOND, {
    maxZoom: 18, tileSize: 256,
    attribution: "Fond : Plan IGN (Géoplateforme, Licence Ouverte)",
  });

  coucheRegions = L.geoJSON(contours, {
    onEachFeature: (feature, couche) => {
      const code = feature.properties.code;
      if (SURVOL_POSSIBLE) couche.bindTooltip(() => bulle({ type: "region", code }), { sticky: true, direction: "top" });
      survol(couche, styleRegion, () => totauxPar("reg"));
      couche.on("click", () => {
        if (OUTRE_MER.includes(code)) afficherTerritoire(code);
        else entrerRegion(code);
      });
    },
  }).addTo(carte);

  // Couche des départements, vide tant qu'aucune région n'est ouverte
  coucheDepts = L.geoJSON(null, {
    onEachFeature: (feature, couche) => {
      const code = feature.properties.code;
      if (SURVOL_POSSIBLE) couche.bindTooltip(() => bulle({ type: "dept", code }), { sticky: true, direction: "top" });
      survol(couche, styleDept, () => totauxPar("dept"));
      couche.on("click", () => entrerDepartement(code));
    },
  }).addTo(carte);

  couchePoints = L.layerGroup().addTo(carte);

  afficherTerritoire("metropole");
}

// Appelée par ouvrirOnglet("carte"). setTimeout : on attend que toute la
// page soit prête (utile si l'adresse est directement #carte).
let promesseCarte = null;
function ouvrirCarte(route = null) {
  setTimeout(async () => {
    if (typeof L === "undefined") {
      document.getElementById("carte-france").textContent = "La bibliothèque de cartes n'a pas pu être chargée.";
      return;
    }
    try {
      promesseCarte ??= creerCarte();
      await promesseCarte;
      carte.invalidateSize();   // la carte était cachée : on lui redonne sa taille
      if (route) {
        await promesseDonnees;  // il faut la liste des lycées pour trouver la zone
        mettreAJourCarte();
        await appliquerRouteCarte(route);
      } else {
        majAdresse();
      }
    } catch (e) {
      console.error(e);
      document.getElementById("carte-france").textContent = "Impossible d'afficher la carte pour le moment.";
    }
  }, 0);
}

/* --- Boutons ------------------------------------------------------ */

document.getElementById("choix-territoire").addEventListener("click", (e) => {
  const t = e.target.closest("button")?.dataset.territoire;
  if (t && carte) afficherTerritoire(t);
});
document.getElementById("carte-retour").addEventListener("click", () => { if (carte) remonter(); });
for (const mode of ["nombre", "proportion"]) {
  document.getElementById("carte-" + mode).addEventListener("click", () => {
    modeCarte = mode;
    document.getElementById("carte-nombre").setAttribute("aria-pressed", String(mode === "nombre"));
    document.getElementById("carte-proportion").setAttribute("aria-pressed", String(mode === "proportion"));
    mettreAJourCarte();
  });
}

/* ===================================================================
   BLOC JS 11 : FICHE D'UN LYCÉE, "MON LYCÉE", RECHERCHE, LIENS
   - ficheLycee() construit la fiche d'un lycée : état actuel, frise des
     7 derniers jours, boutons (signaler, carte, copier le lien...).
     Elle sert à trois endroits : "Mon lycée", la recherche de l'onglet
     Liste et la bulle d'un point sur la carte.
   - "Mon lycée" est gardé dans le navigateur (localStorage) : rien n'est
     envoyé au serveur.
   =================================================================== */

/* --- "Mon lycée" (stockage local) ---------------------------------- */

function lireMonLycee() {
  try { return localStorage.getItem(CONFIG.cleMien); } catch (e) { return null; }
}
function ecrireMonLycee(uai) {
  try {
    if (uai) localStorage.setItem(CONFIG.cleMien, uai);
    else localStorage.removeItem(CONFIG.cleMien);
  } catch (e) { /* stockage bloqué : la fonction est simplement indisponible */ }
  afficherMonLycee();
  majBoutonMonLycee();
}

/* --- Liens partageables -------------------------------------------- */

const lienVers = (suite) => location.origin + location.pathname + "#" + suite;

// Copie un lien ; si le navigateur refuse, on l'affiche pour copie manuelle
async function copierLien(url, bouton) {
  const texte = bouton.textContent;
  try {
    await navigator.clipboard.writeText(url);
    bouton.textContent = "Lien copié ✓";
  } catch (e) {
    window.prompt("Copie ce lien :", url);
  }
  setTimeout(() => { bouton.textContent = texte; }, 2000);
}

/* --- Frise des 7 derniers jours ------------------------------------ */

// Mémoire des historiques déjà chargés : uai -> { quand, heures }
const cacheHistoriques = new Map();

async function historiqueLycee(uai) {
  const c = cacheHistoriques.get(uai);
  if (c && Date.now() - c.quand < 5 * 60 * 1000) return c.heures;     // 5 minutes
  const heures = await api("rpc/historique_lycee", {
    method: "POST", body: JSON.stringify({ code_uai: uai }),
  });
  cacheHistoriques.set(uai, { quand: Date.now(), heures });
  return heures;
}

// La frise : 7 lignes (une par jour, du plus ancien au plus récent),
// 24 cases (une par heure). Les cases sont créées tout de suite (la
// taille de la fiche ne change pas), puis colorées une fois les données
// reçues.
function frise(uai) {
  const zone = element("div", undefined, "frise");
  zone.appendChild(element("div", "Les 7 derniers jours (une case = une heure)", "titre"));
  const cases = new Map();     // "AAAA-MM-JJ HH" -> case
  const cle = (d) => `${d.toLocaleDateString("fr-CA")} ${d.getHours()}`;

  const aujourdhui = new Date(); aujourdhui.setHours(0, 0, 0, 0);
  for (let j = 6; j >= 0; j--) {
    const jour = new Date(aujourdhui); jour.setDate(jour.getDate() - j);
    const ligne = element("div", undefined, "ligne");
    ligne.appendChild(element("span", jour.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric" })));
    for (let h = 0; h < 24; h++) {
      const c = element("span", undefined, "case");
      const d = new Date(jour); d.setHours(h);
      c.title = `${d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric" })}, ${h} h : pas de perturbation confirmée`;
      cases.set(cle(d), c);
      ligne.appendChild(c);
    }
    zone.appendChild(ligne);
  }

  historiqueLycee(uai).then((heures) => {
    for (const { heure, motif } of heures ?? []) {
      const d = new Date(heure);
      const c = cases.get(cle(d));
      if (!c) continue;
      c.style.background = COULEURS_MOTIFS[motif] ?? COULEURS_MOTIFS.autre;
      c.title = c.title.replace("pas de perturbation confirmée", motifParId(motif)?.label ?? motif);
    }
  }).catch(() => {
    zone.querySelector(".titre").textContent = "Historique indisponible pour le moment.";
  });
  return zone;
}

/* --- La fiche ------------------------------------------------------ */

// options.surCarte : la fiche est dans une bulle de la carte (pas de
// bouton "Voir sur la carte") ; options.monLycee : fiche de "Mon lycée"
function ficheLycee(l, options = {}) {
  const p = perturbes.find((x) => x.uai === l.uai);
  const fiche = element("div", undefined, "fiche");
  fiche.appendChild(element("h3", l.nom));
  fiche.appendChild(element("div", `${l.ville} · ${nomDepartement(l.dept)}`, "lieu"));

  if (p) {
    fiche.appendChild(element("span", `Perturbé · ${motifParId(p.motif)?.label ?? p.motif}`, "etat perturbe"));
    fiche.appendChild(element("div",
      `Signalé par ${appareils(p.confirmations)} · dernier signalement ${depuis(Date.parse(p.dernier))}`, "precision"));
  } else {
    fiche.appendChild(element("span", "Aucune perturbation confirmée", "etat calme"));
  }

  // Universités : les composantes présentes sur ce site (UFR, départements...)
  if (l.comp?.length) {
    fiche.appendChild(element("div",
      "Sur ce site : " + l.comp.slice(0, 6).join(" · ") + (l.comp.length > 6 ? " …" : ""), "composantes"));
  }

  fiche.appendChild(frise(l.uai));

  const actions = element("div", undefined, "actions");
  const bSignaler = element("button", `Signaler l'état de ${M.ce}`, "principal");
  bSignaler.type = "button";
  bSignaler.addEventListener("click", () => {
    location.hash = "signaler";
    choisir(l);
    document.getElementById("formulaire").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  actions.appendChild(bSignaler);

  if (!options.surCarte && l.lat != null) {
    const aCarte = element("a", "Voir sur la carte");
    aCarte.href = `#carte/${ROUTE}/` + l.uai;
    actions.appendChild(aCarte);
  }

  const bLien = element("button", "Copier le lien");
  bLien.type = "button";
  bLien.addEventListener("click", () => copierLien(lienVers(`carte/${ROUTE}/` + l.uai), bLien));
  actions.appendChild(bLien);

  const estLeMien = lireMonLycee() === l.uai;
  const bMien = element("button", options.monLycee ? "Retirer" : (estLeMien ? `★ ${M.Mon}` : `☆ ${M.Mon}`));
  bMien.type = "button";
  bMien.title = options.monLycee || estLeMien ? `Ne plus suivre ${M.ce}` : `Afficher ${M.ce} en tête de l'onglet Signaler`;
  bMien.addEventListener("click", () => {
    const deja = lireMonLycee() === l.uai;
    ecrireMonLycee(deja ? null : l.uai);
    if (!options.monLycee) bMien.textContent = deja ? `☆ ${M.Mon}` : `★ ${M.Mon}`;
  });
  actions.appendChild(bMien);

  fiche.appendChild(actions);
  return fiche;
}

/* --- "Mon lycée" en tête de l'onglet Signaler ----------------------- */

let monLyceeAffiche = null;   // pour ne pas redessiner la frise inutilement
function afficherMonLycee() {
  const zone = document.getElementById("mon-lycee");
  const l = lyceeParUai(lireMonLycee());
  if (!l) { zone.hidden = true; zone.textContent = ""; monLyceeAffiche = null; return; }
  // Redessin seulement si le lycée ou son état a changé
  const p = perturbes.find((x) => x.uai === l.uai);
  const signature = `${l.uai}|${p?.motif}|${p?.confirmations}|${p?.dernier}`;
  if (signature === monLyceeAffiche) return;
  monLyceeAffiche = signature;
  zone.textContent = "";
  const entete = element("div", undefined, "entete");
  entete.appendChild(element("span", M.Mon));
  zone.appendChild(entete);
  zone.appendChild(ficheLycee(l, { monLycee: true }));
  zone.hidden = false;
}

// Bouton "☆ Enregistrer comme mon lycée" du formulaire
function majBoutonMonLycee() {
  const b = document.getElementById("btn-mon-lycee");
  if (!lyceeChoisi) return;
  const mien = lireMonLycee() === lyceeChoisi.uai;
  b.textContent = mien ? `★ C'est ${M.mon}` : `☆ Enregistrer comme ${M.mon}`;
  b.setAttribute("aria-pressed", String(mien));
}
document.getElementById("btn-mon-lycee").addEventListener("click", () => {
  if (!lyceeChoisi) return;
  ecrireMonLycee(lireMonLycee() === lyceeChoisi.uai ? null : lyceeChoisi.uai);
});

/* --- Recherche dans l'onglet Liste ---------------------------------- */

let lyceeRecherche = null;
function montrerFicheRecherche(l, defiler = true) {
  lyceeRecherche = l;
  const zone = document.getElementById("resultat-recherche");
  zone.textContent = "";
  zone.appendChild(ficheLycee(l));
  document.getElementById("champ-stats").value = `${l.nom} (${l.ville})`;
  history.replaceState(null, "", `#stats/${ROUTE}/` + l.uai);
  if (defiler) document.getElementById("recherche-stats").scrollIntoView({ behavior: "smooth", block: "start" });
}

autocompletion(document.getElementById("champ-stats"),
               document.getElementById("suggestions-stats"),
               (l) => montrerFicheRecherche(l, false));

// Lien partagé "#stats/lycee/UAI" : on attend que la liste des lycées soit chargée
async function ouvrirFicheDepuisAdresse(uai) {
  await promesseDonnees;
  const l = lyceeParUai(uai);
  if (l) montrerFicheRecherche(l);
}

/* --- Bandeau "pause" ------------------------------------------------ */

function majPause() {
  document.getElementById("bandeau-pause").hidden = !servicePause;
  document.getElementById("valider").disabled = servicePause;
}

/* --- Menus de filtre (remplis une fois la liste des lycées chargée) - */

function remplirFiltres() {
  // Régions présentes dans lycees.json, puis départements
  const regs = [...new Set(LYCEES.map((l) => l.reg).filter(Boolean))]
    .sort((a, b) => (REGIONS[a] ?? a).localeCompare(REGIONS[b] ?? b, "fr"));
  const depts = [...new Set(LYCEES.map((l) => l.dept))].sort();

  const filtre = document.getElementById("filtre-zone");
  const choixJours = document.getElementById("choix-region-jours");
  if (regs.length) {
    const gr = document.createElement("optgroup"); gr.label = "Régions";
    for (const r of regs) gr.appendChild(new Option(REGIONS[r] ?? r, "reg:" + r));
    filtre.appendChild(gr);
    for (const r of regs) choixJours.appendChild(new Option(REGIONS[r] ?? r, r));
  }
  const gd = document.createElement("optgroup"); gd.label = "Départements";
  for (const d of depts) gd.appendChild(new Option(`${nomDepartement(d)} (${d.replace(/^0/, "")})`, "dept:" + d));
  filtre.appendChild(gd);

  filtre.addEventListener("change", afficherListe);
  choixJours.addEventListener("change", afficherStatistiques);
}

/* ===================================================================
   BLOC JS 9 : DÉMARRAGE
   rafraichir() redessine tout. Toutes les 30 secondes, on recharge
   les signalements pour voir ceux des autres visiteurs.
   =================================================================== */
function rafraichir() {
  afficherListe();
  afficherStatistiques();
  mettreAJourCarte();
  afficherMonLycee();
  majPause();
  // La fiche affichée dans la recherche suit aussi l'état actuel
  if (lyceeRecherche) {
    const zone = document.getElementById("resultat-recherche");
    zone.textContent = "";
    zone.appendChild(ficheLycee(lyceeRecherche));
  }
}

/* ===================================================================
   BLOC JS 12 : LE FICHIER DE DONNÉES OUVERTES
   La base renvoie un résumé (jour, code du lycée, motif, heures) ; on y
   ajoute ici le nom, la ville, le département, la région et le statut
   (tirés de lycees.json), puis on fabrique le fichier CSV directement
   dans le navigateur : rien d'autre n'est demandé au serveur.
   =================================================================== */
async function telechargerDonnees() {
  const bouton = document.getElementById("btn-donnees");
  const message = document.getElementById("message-donnees");
  bouton.disabled = true;
  message.textContent = "Préparation du fichier…";
  try {
    await promesseDonnees;          // lycées et motifs chargés
    const lignes = await api("rpc/donnees_ouvertes", { method: "POST", body: JSON.stringify(TYPE) });
    if (!lignes?.length) {
      message.textContent = `Aucun ${M.un} n'a été confirmé comme perturbé ces 30 derniers jours.`;
      return;
    }
    // Un champ CSV : entre guillemets, guillemets internes doublés
    const csv = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const statuts = { public: "public", prive: "privé" };
    const entete = ["jour", CONFIG.colonnesCsv.code, CONFIG.colonnesCsv.nom, "ville", "departement", "code_departement",
                    "region", "statut", "motif", "heures_perturbees"];
    const contenu = lignes.map((r) => {
      const l = lyceeParUai(r.uai) ?? {};
      return [
        r.jour, r.uai, l.nom, l.ville,
        l.dept ? nomDepartement(l.dept) : "",
        (l.dept ?? "").replace(/^0/, ""),         // "069" -> "69", "02A" -> "2A"
        REGIONS[l.reg] ?? "",
        statuts[l.statut] ?? "",
        motifParId(r.motif)?.label ?? r.motif,
        r.heures,
      ].map(csv).join(";");
    });
    // Point-virgule et "BOM" (﻿) : Excel en français ouvre ainsi le
    // fichier avec les bonnes colonnes et les accents corrects
    const fichier = new Blob(["﻿" + [entete.join(";"), ...contenu].join("\r\n")],
                             { type: "text/csv;charset=utf-8" });
    const lien = document.createElement("a");
    lien.href = URL.createObjectURL(fichier);
    lien.download = `${CONFIG.fichierCsv}-${new Date().toLocaleDateString("fr-CA")}.csv`;
    document.body.appendChild(lien);
    lien.click();
    lien.remove();
    setTimeout(() => URL.revokeObjectURL(lien.href), 10000);
    message.textContent = `Fichier téléchargé : ${lignes.length} ligne(s).`;
  } catch (e) {
    console.error(e);
    message.textContent = "Téléchargement impossible pour le moment. Réessaie plus tard.";
  } finally {
    bouton.disabled = false;
  }
}
document.getElementById("btn-donnees").addEventListener("click", telechargerDonnees);

// promesseDonnees : terminée quand lycées, motifs et état sont chargés.
// Les liens partagés (#carte/lycee/...) l'attendent avant de s'appliquer.
let promesseDonnees = null;

async function demarrer() {
  try {
    // On charge les trois sources en parallèle (plus rapide)
    promesseDonnees = Promise.all([chargerLycees(), chargerMotifs(), chargerEtat()]);
    await promesseDonnees;
    remplirMotifs();
    remplirFiltres();
    rafraichir();
  } catch (e) {
    console.error(e);
    document.getElementById("liste").textContent =
      "Impossible de joindre la base de données. Réessaie plus tard.";
  }
  // Toutes les 30 s : on recharge l'état calculé par le serveur
  setInterval(async () => {
    try { await chargerEtat(); rafraichir(); } catch (e) { /* on réessaiera */ }
  }, 30000);
}
demarrer();