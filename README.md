# Sonepar Hyllsök – Jönköping

Hyllsök för butiksskärmen i Sonepar Jönköping. Personal och kunder skriver eller skannar ett
artikelnummer och ser direkt vilken hyllsida artikeln ligger på, med butikskarta som tillval.
Byggd på Cloudflare Workers (sida + API) och Cloudflare D1 (artikelregistret). Av Karlik solutions.

## Filer

```
wrangler.jsonc                          Inställningar: Worker-namn, D1-koppling, mappen public
src/index.js                            API:t (sök, inloggning, artiklar, import/export, loggar)
public/index.html                       Själva sidan (sök, karta, adminläge)
public/sonepar-favicon-png-data.png     Logotypen
```

## Inställningar i Cloudflare

| Vad | Värde |
|-----|-------|
| Worker | `sonepar-jonkoping` |
| D1-databas | `jkpg_db` (binding `jkpg_db`) |
| Hemlighet | `ADMIN_PASSWORD` – lösenordet till adminläget. Settings → Variables and Secrets, typ **Secret** |

Workern skapar själv de extra tabeller den behöver (`meta`, `saknas`, `andringar`) första gången den körs.
Artikeltabellen `artiklar` (artikelnummer, hyllsida, beteckning) finns redan.

## Funktioner

**Butiksskärmen**
- Sök eller skanna artikelnummer. Korta sifferkoder fylls ut med nollor (4211 → 0004211).
- Hela registret sparas i webbläsaren, så sökningen är snabb och fungerar även om internet går ner.
- Skärmen kollar efter ändringar varannan minut och töms av sig själv 30 sekunder efter senaste sökningen.
- Sökningar som inte gav träff rapporteras till adminlistan *Sökt men saknas*.

**Butikskarta** (av som standard, ställs in per skärm i adminläget)
- Visar rätt hyllsida och gångväg från kassan i 10 sekunder efter en sökning.
- Stor skärm: bredvid sökningen. Surfplatta/mobil (under 1 200 px bred): som popup.
- Kan vridas 90° åt gången så att den stämmer med hur skärmen står.
- Kartan ritas i koden (`public/index.html`, avsnittet *Butikskarta*). Flyttas hyllor måste den ritas om där.

**Adminläget** (länken *Admin* längst ner, eller `/#admin`)
- Lägg till, ändra och ta bort artiklar. Varnar om hyllsidan inte finns på kartan.
- **Importera** från Excel (.xlsx), CSV eller inklistrat. Lägger till och uppdaterar – tar aldrig bort.
  Kontrollvy före sparning. Max 1 000 rader åt gången.
- **Exportera** hela registret till Excel som säkerhetskopia.
- **Sökt men saknas**: artikelnummer som söktes men inte fanns (senaste 90 dagarna).
- **Senaste ändringar**: logg med *Ångra* (även hela importer).
- Loggas ut automatiskt efter 5 minuter utan aktivitet.

## Säkerhetskopiering

- Knappen **Exportera** i adminläget – ta en kopia före större importer.
- D1 **Time Travel** kan återställa databasen till valfri tidpunkt de senaste dagarna
  (Cloudflare → D1 → jkpg_db → Time Travel).

## Uppdatera sidan

Ändringar på GitHub byggs automatiskt av Cloudflare. Se byggstatus under
Workers & Pages → sonepar-jonkoping → Deployments. Gå tillbaka till en tidigare version med *Rollback*
där, eller genom att återställa filen i GitHubs historik.
