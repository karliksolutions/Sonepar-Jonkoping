# Sonepar Hyllsök – version 1

Hyllsök för butiksskärmen i Sonepar Jönköping, med adminläge för artikelregistret.
Byggd på Cloudflare Workers (statiska filer + API) och Cloudflare D1.

## Filer

```
wrangler.jsonc        Inställningar: Worker-namn, D1-koppling, mappen public
src/index.js          API:t (sök, inloggning, lägga till/ändra/ta bort artiklar)
public/index.html     Själva sidan (sök + adminläge)
public/sonepar-favicon-png-data.png   Logotypen
```

## Inställningar i Cloudflare

- **D1-binding:** `jkpg_db` (anges i `wrangler.jsonc`)
- **Hemlighet `ADMIN_PASSWORD`:** lösenordet till adminläget. Läggs in under
  Workers & Pages → din Worker → Settings → Variables and Secrets, som typen *Secret*.

## Så fungerar det

- Skärmen hämtar hela artikellistan från D1 när sidan laddas och sparar en kopia i webbläsaren.
  Sökningen sker sedan direkt i kopian, så den är snabb och fungerar även om internet går ner.
- Varannan minut frågar skärmen om registret har ändrats. Bara då hämtas listan om.
- Adminläget öppnas via länken **Admin** längst ner, eller genom att gå till `/#admin`.
- Admin loggas ut automatiskt efter 5 minuter utan aktivitet, och inloggningen gäller högst 8 timmar.

## API

| Metod  | Adress                          | Inloggning | Gör |
|--------|---------------------------------|------------|-----|
| GET    | `/api/version`                  | Nej        | Registrets versionsnummer |
| GET    | `/api/artiklar`                 | Nej        | Alla artikelnummer med hyllsida |
| POST   | `/api/login`                    | Nej        | Loggar in med `{ "password": "…" }` |
| POST   | `/api/logout`                   | Nej        | Loggar ut |
| GET    | `/api/admin/artiklar?q=…`       | Ja         | Sök (max 200 träffar) |
| POST   | `/api/admin/artiklar`           | Ja         | Lägg till artikel |
| PUT    | `/api/admin/artiklar/{nummer}`  | Ja         | Ändra hyllsida och beteckning |
| DELETE | `/api/admin/artiklar/{nummer}`  | Ja         | Ta bort artikel |

Workern skapar själv en liten tabell `meta` i D1 som håller reda på registrets version.
