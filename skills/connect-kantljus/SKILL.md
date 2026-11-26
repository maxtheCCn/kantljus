---
name: connect-kantljus
description: 'Kopplar Claude till Kantljus admin på kantljus.se för {{NAMN}}. Använd så fort användaren startar, bygger, designar om eller levererar en hemsida eller annat arbete åt ett företag, när de frågar om något i Kantljus admin (Att ringa, Ring tillbaka, företag, kunder, samtal, vem som jobbar) eller säger "rapportera till Kantljus".'
---

# Connect till kantljus.se

Den här skillen hör till **{{NAMN}}** i Kantljus. Den låter dig se och ändra i Kantljus admin och rapportera vad {{NAMN}} jobbar med, så att teamet ser det på kantljus.se/admin.

Allt görs med skriptet `scripts/kantljus.py` i den här skillens mapp. Kör det med `python3` (på Windows `python`). Namn och nyckel ligger i `config.json`. **Visa, citera eller skriv aldrig ut nyckeln**, och lägg den aldrig i en fil, ett meddelande eller en hemsida.

## När ett projekt startar

Så fort användaren börjar bygga, designa om eller göra annat arbete åt ett företag:

1. Ta fram företagets namn ur det användaren skrev. Kör `python3 scripts/kantljus.py sok "<namn>"`. Sök också på telefonnummer om du har ett.
2. Fråga en gång, kort, med knappar om appen har det:
   **Ska jag rapportera det här till kantljus.se?**
   - Ja, under <Företag> (<telefon>): när du hittade en träff. Visa högst två träffar.
   - Annat företag
   - Skapa nytt företag
   - Nej, inte nu
3. Gör sedan det användaren valde:
   - Befintligt företag: `jobbar --id <id> --vad "Hemsida åt <Företag>"`
   - Nytt företag: `nytt --namn "<Företag>" --telefon "<tel>" --adress "<adress>" --bransch "<bransch>"`, sedan `jobbar --id <nytt id> --vad "..."`
   - Nej: rapportera inget mer i den här chatten om inte användaren ber om det.
4. Fortsätt direkt med själva arbetet. Rapporteringen får aldrig stoppa arbetet.

Skriv `--vad` kort och konkret, som "Hemsida åt Salong Vera" eller "Ny bokningssida åt Bistro Nio".

## När arbetet är klart

När hemsidan är levererad, eller när användaren säger att de är klara: kör `klar --notis "<en mening om vad som gjordes>"`. Har användaren bytt till ett annat företag kör du `jobbar` igen med det nya. Det ersätter det gamla.

## Kommandon

| Kommando | Vad det gör |
|---|---|
| `vem` | Testar anslutningen och visar vem du är inloggad som |
| `sok "text"` | Söker på namn, ort, bransch eller telefonnummer |
| `lista [att_ringa\|tillbaka\|ja\|kunder\|mina\|alla]` | Listor som i admin. `tillbaka` = ska ringas idag eller tidigare |
| `visa <id>` | Allt om ett företag, inklusive de senaste samtalen och arbetet |
| `nytt --namn ... [--telefon --adress --bransch --webb --kontakt --epost --notis]` | Lägger till i Att ringa. Hoppar över dubbletter med samma nummer |
| `andra <id> falt=värde ...` | Ändrar namn, telefon, ort, bransch, webb, kontakt, epost, ansvarig, hemsidaNotis |
| `samtal <id> --utfall <inget_svar\|aterkom\|intresserad\|mote\|offert\|kund\|nej> [--notis] [--nar ÅÅÅÅ-MM-DD]` | Loggar ett samtal i {{NAMN}}s namn |
| `status <id> <status>` | Ändrar status. Fungerar bara för Max |
| `jobbar --vad "..." [--id <id>]` | Visar i admin vad {{NAMN}} jobbar med just nu |
| `klar [--notis "..."]` | Tar bort "jobbar just nu" och loggar att det är klart |
| `vilka` | Visar vem i teamet som jobbar med vad just nu |

## Regler

- Ta aldrig bort företag och ändra aldrig någon annans samtal. Det går inte med skillen.
- Gör det användaren ber om. Fråga först om det gäller många företag på en gång, till exempel mer än 10 nya.
- Visa resultat som en kort lista med namn, telefon och status, inte rå data.
- **FEL 401**: nyckeln är avstängd. Säg att {{NAMN}} ska ladda ner skillen igen under Skills i admin.
- **FEL 403**: det är något bara Max får göra. Säg det kort.
- **NÄTVERK**: Claude kommer inte åt kantljus.se. Be användaren lägga till `kantljus.se` som tillåten domän i Claudes inställningar, en gång. Fortsätt sedan med arbetet ändå.
- Skillen kan användas tillsammans med kantljus-signatur. Båda ska följas när en hemsida byggs.
