# HubSpot → SalesMap daily sync (runbook)

Run by a scheduled Claude task on Miguel's Mac each morning, using his HubSpot connector
login (he is not a HubSpot admin, so there is no API token) and the Supabase connector
signed in to the AllterraCentralMGIS org. All matching rules live in the database
function `public.hubspot_ingest(jsonb)`; this runbook only gathers the data and calls it.

Supabase project: `klkjpwgjnaozhatfopvd` (SalesMaps). HubSpot portal: 42546529.

## Rules (decided 2026-11-23, enforced by `hubspot_ingest`)

- HubSpot → SalesMap only. HubSpot stays the record.
- Only meetings owned by a rep in `hubspot_owners` (Miguel, Jeremy Scott, Joseph Zequeira, Kevin Bailey).
- In-person only: a location that isn't Teams/Zoom/Webex/Meet/online/virtual/phone/call/http.
- More than 8 contacts = an event (e.g. GIS Day): skipped, listed for review.
- Exact contact-email match to a SalesMap customer only. No company-wide spillover:
  other reps own other contacts at the same company.
- A customer who already has a visit that day is left alone.
- Unmatched contacts go to the review list (`not_on_map`, `same_company`).
- Visits are credited to the meeting's owner; `visits.hubspot_meeting_id` is
  `<meeting id>:<customer id>`, which makes reruns safe.

## Steps

1. **Window.** Read the last run:
   `select coalesce(max(window_end), '2026-11-24T06:00:00Z') from hubspot_sync_log;`
   Use `since` = that value minus 1 day (overlap catches meetings logged late), `until` = now (UTC).
2. **Owners.** `select owner_id from hubspot_owners;`
3. **Meetings.** HubSpot `search_crm_objects`, objectType `MEETING`, filters:
   `hubspot_owner_id IN <owners>` AND `hs_lastmodifieddate GTE <since>` AND
   `hs_meeting_start_time LTE <until>`. Properties: `hs_meeting_start_time`,
   `hs_meeting_location`, `hubspot_owner_id`, `hs_meeting_title`. Page with `offset` until all `total` are read.
   - Drop meetings whose location is empty or matches the remote words above (saves lookups).
   - For each remaining meeting, get its contacts: objectType `CONTACT`, properties `["email"]`,
     limit 50, filterGroups `[{"associatedWith":[{"objectType":"meetings","operator":"EQUAL","objectIdValues":[<id>]}]}]`.
     Lowercase the emails; skip contacts without one.
4. **Deals.** objectType `DEAL`, filters `hubspot_owner_id IN <owners>` AND
   `hs_lastmodifieddate GTE <since>` (closed deals included, so they flip to closed).
   Properties: `dealname`, `dealstage`, `pipeline`, `amount`, `deal_currency_code`, `closedate`,
   `hubspot_owner_id`, `hs_lastmodifieddate`, `hs_is_closed`.
   For each deal get its contacts the same way with `"objectType":"deals"`.
   - `stage_label`: the `dealstage` option label (fetch once with `get_properties` deals
     `["dealstage"]` and map value → label).
   - `is_open` = `hs_is_closed` is not `"true"`.
   - `url` = `https://app.hubspot.com/contacts/42546529/record/0-3/<deal id>`.
5. **Ingest.** One call:
   ```sql
   select public.hubspot_ingest($j${
     "window_start": "<since>", "window_end": "<until>",
     "meetings": [{"id","owner_id","start","title","location","contact_emails":[...]}],
     "deals": [{"id","name","pipeline_id","stage_id","stage_label","is_open","amount",
                "currency","close_date","owner_id","url","updated_at","contact_emails":[...]}]
   }$j$::jsonb);
   ```
   Use a dollar-quote tag that can't appear in the data. Split into several calls if the payload is very large.
6. **Report.** Reply with: visits added, deals synced, and the review list grouped by type
   (event / same_company / not_on_map) with meeting title, date and email. Nothing else is
   written: never create customers, never edit HubSpot.

## Known gaps

- Deal ↔ customer links are only added, never removed, so a contact taken off a deal stays
  linked until cleaned up by hand.
- Runs only when the Mac is on and awake; a missed day is caught by the next run's window.
