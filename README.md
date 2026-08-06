# pronatura

Widget Grist personnalisé qui affiche sur une carte Leaflet les parcelles
(réserves Pro Natura) d'une table Grist, à partir de leur numéro **EGRID**.

## Fonctionnement

- La géométrie de chaque parcelle est récupérée depuis le géoportail suisse
  (api3.geo.admin.ch) via son EGRID, puis reprojetée de CH1903+/LV95 vers
  WGS84.
- Elle est mise en cache dans la colonne `GeoJSON` de la table (si mappée),
  pour éviter de la retélécharger à chaque ouverture.
- Le bouton "Actualiser depuis le géoportail" force un nouveau téléchargement
  pour toutes les lignes (utile si une limite de parcelle a été corrigée).

## Mise en place dans Grist

1. Héberger `map.html` et `map.js` (actuellement sur Netlify) et ajouter un
   **Custom Widget** dans Grist pointant vers l'URL de `map.html`.
2. Accorder l'accès **Full document access** au widget (nécessaire pour
   écrire le cache GeoJSON).
3. Dans le panneau de configuration (Creator Panel), mapper les colonnes :

   | Champ du widget | Requis | Description |
   |---|---|---|
   | **EGRID** | Oui | Un ou plusieurs EGRID — voir "Une ou plusieurs parcelles par ligne" ci-dessous |
   | **Nom** | Non | Affiché dans la popup (ex. nom de la réserve) |
   | **Réserve** | Non | Regroupe les lignes en calques activables/désactivables |
   | **Étiquette** | Non | Texte affiché en permanence sur la/les parcelle(s) |
   | **GeoJSON (cache)** | Non | Colonne texte où la géométrie est mise en cache |

Sans colonne de cache mappée, le widget fonctionne quand même mais
retélécharge la géométrie de chaque parcelle à chaque ouverture.

## Une ou plusieurs parcelles par ligne

La colonne **EGRID** accepte deux formats, utiles pour deux cas d'usage
différents :

- **Table "Parcelles"** (une ligne = une parcelle) : colonne texte avec un
  seul EGRID.
- **Table "Réserves"** (une ligne = plusieurs parcelles) : soit une colonne
  texte avec plusieurs EGRID séparés par des virgules, soit une colonne de
  référence (**Ref** ou **RefList**) vers une table de parcelles — la table
  référencée doit alors avoir elle-même une colonne dont l'identifiant
  (colId) est exactement `EGRID`.

Dans les deux cas, les géométries de toutes les parcelles d'une ligne sont
combinées et mises en cache ensemble dans la colonne GeoJSON de cette ligne.
