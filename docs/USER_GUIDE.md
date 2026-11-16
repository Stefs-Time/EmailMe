# MailHarbor user guide

The same guidance is available inside MailHarbor under **Guides**.

## What MailHarbor is for
MailHarbor is where you **manage your contact database**: import it, sort it, keep it clean and prove consent.
Emails are written and sent in **listmonk** (button *New campaign in listmonk*, bottom-left). Both share one database:
changes appear in both immediately, and bounces and unsubscribes from listmonk flow back into MailHarbor automatically.

**The golden rule:** once someone unsubscribes, bounces permanently or complains, they are **suppressed**. Nothing (not an
import, a list change or an edit in listmonk) can quietly email them again. Only an administrator can reactivate them,
and only with documented new consent.

## Daily tasks

### Find contacts
**Contacts** → type in the search box (email, name or company). Narrow down with the **status**, **list**, **source** and
**consent** filters, and click a column heading to sort. Choose *Eligible to receive* to see exactly who your next campaign will reach.

### Add one contact
Contacts → **Add contact**. Enter the email address and choose the lists. Recording **consent** (method, date, purpose,
evidence) is required: having someone's address is not permission to market to them.

### Import a spreadsheet
1. Save the file as **CSV UTF-8** (Excel: *File → Save As → CSV UTF-8*). First row = column names.
2. **Import** → drop the file in.
3. Check the column matching. Choose lists and a default consent basis for rows without a consent column.
4. **Check my data.** Every row is sorted into a group: new, existing (added to lists), existing (no change),
   suppressed, invalid email, duplicate, invalid data, or no consent basis. Nothing is saved yet.
5. **Import.** Afterwards, download the row report for the excluded rows, fix them and import them again if appropriate.

Template: download it from the Import page. Recommended columns: `email, first_name, last_name, company, source,
consent_method, consent_date, consent_purpose`. Any extra column becomes a custom attribute you can use in emails, e.g.
`{{ .Subscriber.Attribs.city }}`.

### Lists
**Lists** shows members, unsubscribes and *Will receive* (the people who would actually get a campaign). Create lists
for audiences or interests. *Double opt-in* lists email new members a confirmation link first.

### Update or remove someone
Open the contact:
- **Edit** to change details;
- **Actions → Manage lists / Record consent / Unsubscribe / Suppress**;
- **Data export** for "what do you hold about me?" requests;
- **Erase** (administrators) for POPIA deletion requests.

Phone or email opt-out requests: **Actions → Unsubscribe** and note how the request arrived.

### Send a campaign (in listmonk)
New campaign → name, subject, From address, lists → template and content (personalise with `{{ .Subscriber.FirstName }}`)
→ **Send test** to yourself → **Schedule** or **Start**. Keep the unsubscribe link. Each person receives an individual
email; recipients never see each other.

### Read the results
**Campaign reports**: sent, delivery failures, hard/soft bounces, complaints, unsubscribes, opens and clicks.
- Bounce rate above **2%** deserves attention; above **5%** the list needs cleaning.
- Complaints should stay below **0.1%**.
- Opens are indicative only: privacy features and scanners distort them. Clicks are more reliable.

**Audience & bounces** shows where contacts come from, their consent basis, growth, and bounce trends by day, code and domain.

### Review queue
Some rejections (e.g. *5.7.1 blocked as spam*) do not prove an address is bad: often our own sending setup is at fault.
These contacts are **held** (not emailed) and listed under **Review queue**. Choose *Valid – release* (restores their
lists) or *Suppress*. Many at once? Ask your administrator to check SPF/DKIM/DMARC first.

### Exports
**Exports** offers contacts, eligible contacts, suppression list, consent history, status history, bounces, campaign
report and (administrators) the audit log. Files open directly in Excel. Every export is logged. Store and share them securely.

## Statuses

| Status | Meaning | Gets campaigns? |
|---|---|---|
| Active | Valid, subscribed | Yes |
| Soft bounced | Temporary failure; blocked after the limit | Yes, until the limit |
| Unconfirmed | Hasn't confirmed a double opt-in | No |
| Pending review | Held after a policy/spam rejection | No |
| Hard bounced | Address doesn't exist | No (suppressed) |
| Complaint | Marked as spam | No (suppressed) |
| Unsubscribed | Opted out | No (suppressed) |
| Blocklisted | Suppressed manually or in listmonk | No |
| No lists | On no list | No |

## Roles

| Role | Can |
|---|---|
| Viewer | Dashboards, contacts, lists, reports (read-only, no exports) |
| Manager | + add/edit contacts, lists, import, export, unsubscribe, suppress, resolve reviews |
| Administrator | + users, reactivate suppressed contacts, erase contacts, audit log |

## FAQ
- **A contact I imported isn't on the list.** Check the row report in *Import history*: they were probably suppressed,
  had previously unsubscribed from that list, or had no consent basis.
- **Why can't I re-add someone who unsubscribed?** By design: they must opt in again, or an administrator records new consent.
- **Some export values start with an apostrophe.** Values beginning with `= + - @` are prefixed so spreadsheets cannot run them as formulas.
- **Forgot my password?** Ask an administrator to reset it (Users → Edit).
