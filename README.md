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

1. Héberger `map.html` et `map.js` (ex. GitHub Pages) et ajouter un
   **Custom Widget** dans Grist pointant vers l'URL de `map.html`.
2. Accorder l'accès **Full document access** au widget (nécessaire pour
   écrire le cache GeoJSON).
3. Dans le panneau de configuration (Creator Panel), mapper les colonnes :

   | Champ du widget | Requis | Description |
   |---|---|---|
   | **EGRID** | Oui | Colonne texte contenant l'EGRID de la parcelle |
   | **Nom** | Non | Affiché dans la popup (ex. nom de la réserve) |
   | **Réserve** | Non | Regroupe les parcelles en calques activables/désactivables |
   | **GeoJSON (cache)** | Non | Colonne texte où la géométrie est mise en cache |

Sans colonne de cache mappée, le widget fonctionne quand même mais
retélécharge la géométrie de chaque parcelle à chaque ouverture.
