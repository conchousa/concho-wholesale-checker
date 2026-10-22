# Concho Wholesale Checker

One screen for every wholesale lead:

1. **Find their CLC retailer code.** Search the CLC retailer list by store name or code. Pick the code and the store type (BDPT, CAMP, SGSS...) comes with it. If they aren't in the list, hit "Not in the list" and the app drafts the CLC request email (store name, location, buyer name and email).
2. **Pick the schools they want.** Every school chip turns green or red for that store type, straight from the Active Channels sheet.
3. **Next step.** Ready to invoice, partly covered, not licensed, or check with CLC. It flags missing royalty rates, restricted grants (Iowa, the vintage marks), and Affinity's golf-shop caveat, then drafts the message to the buyer.

Saved leads go to the **Lead log** (filter by "Waiting on CLC code" to chase codes, "Mark invoiced" when done). Any school a store asked for that we can't sell into their store type gets tallied on **License demand**, so you can see which licenses are worth applying for.

## Updating the data

Use the **Data** tab. Upload the new monthly CLC retailer list or an updated Active Channels sheet and the checker switches over right away. Keep the same columns:

- Retailer list: `Retailer Code`, `Retailer Name`, `Retailer Type`
- Active Channels: school in column A, then `RRET SMT SGSS BDPT CAMP GLFS`, plus `ROYALTY RATE`, `LICENSOR`, `AGREEMENT`, `NOTES`

The copies in `data/` are the October 2026 list and the 8/10 channels sheet. They're used until something is uploaded.

Store type names live in `channels.py`. Those are working labels, edit them to match CLC's wording if you like.

## Deploy on Render

1. Push this folder to a GitHub repo (private).
2. In Render: **New > Blueprint**, pick the repo. It reads `render.yaml`.
3. Fill in the environment variables when prompted:
   - `APP_PASSWORD`: shared password for the team (browser asks for it; username can be anything)
   - `CLC_EMAIL`: your CLC rep's address so "Open in email" is pre-addressed
4. Deploy. First boot takes about a minute.

The blueprint uses the Starter plan with a 1 GB disk at `/var/data`. That disk is what keeps the lead log and uploaded spreadsheets around between deploys. On the free plan the app still works, but the lead log and uploads reset every time it restarts.

## Run it locally

```bash
pip install -r requirements.txt
python app.py        # http://localhost:5000
```
