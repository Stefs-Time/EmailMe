# MailHarbor user guide

The same guidance is available inside MailHarbor under **Guides**.

## What MailHarbor is for

MailHarbor is where you **manage your contact database and send email campaigns to it**. You can:
- import and sort contacts;
- keep them clean and prove consent;
- write and send newsletters;
- see who opened, clicked, bounced or unsubscribed.

**The golden rule:** once someone unsubscribes, bounces permanently or complains, they are **suppressed**. Nothing
quietly emails them again: not an import, a list change or a new campaign. MailHarbor even re-checks each person a second
before sending. Only an administrator can reactivate them, and only with documented new consent.

## Daily tasks

### Find contacts
Go to **Contacts** and type in the search box (email, name or company). To narrow the results, use the **status**,
**list**, **source** and **consent** filters. Click a column heading to sort. Choose *Eligible to receive* to see exactly
who a campaign would reach.

### Add one contact
Go to Contacts → **Add contact**. Enter the email address and choose the lists. You must record **consent** (method,
date, purpose, evidence): having someone's address is not permission to market to them.

### Import a spreadsheet
1. Save the file as **CSV UTF-8** (Excel: *File → Save As → CSV UTF-8*). The first row holds the column names.
2. Go to **Import** and drop the file in.
3. Check the column matching. Choose the lists, and a default consent basis for rows that have no consent column.
4. Click **Check my data**. Every row is sorted into a group, and nothing is saved yet. The groups are:
   - new;
   - existing (added to lists);
   - existing (no change);
   - suppressed;
   - invalid email;
   - duplicate;
   - invalid data;
   - no consent basis.
5. Click **Import**. Afterwards, download the row report for the excluded rows. Fix them and import them again if appropriate.

You can download a template from the Import page. Recommended columns: `email, first_name, last_name, company, source,
consent_method, consent_date, consent_purpose`. Any extra column becomes a custom attribute that you can use in emails,
for example `{{ attribs.city }}`.

On a **double opt-in** list, new people receive a confirmation email first. They join only when they click
*Confirm* on the page that link opens.

### Lists
**Lists** shows:
- members;
- unconfirmed;
- unsubscribed;
- **Will receive**: the people who would actually get a campaign.

Create lists for audiences or interests. Choose *Double opt-in* when people sign up themselves.

### Update or remove someone
Open the contact:
- **Edit** to change details;
- **Actions → Manage lists / Record consent / Unsubscribe / Suppress**;
- **Data export** for "what do you hold about me?" requests;
- **Erase** (administrators) for POPIA deletion requests.

The contact page also lists every email sent to the person, with opens, clicks and bounces.

For an opt-out request by phone or email, use **Actions → Unsubscribe** and note how the request arrived.

## Campaigns

### Write
1. Go to **Campaigns → New campaign** (or the button at the bottom-left). Give it an internal name and choose a template.
2. Fill in:
   - **Subject**;
   - **Preheader**: the grey preview text next to the subject in the inbox;
   - **From**: leave empty to use the default sender;
   - **Lists**.

   The panel on the right shows **how many people will receive it**. That count already excludes suppressed,
   unconfirmed and held contacts.
3. Design the content in the **Builder** (see *The drag-and-drop builder* below). The **Plain text** tab is generated
   automatically; edit it if you want. If you prefer to write or paste HTML, use the **Visual** or **HTML** editor.
   Converting a design to HTML is one-way: it comes back into the builder as a single HTML block.
4. **Personalise** with tags such as `{{ first_name | "there" }}`. The text after `|` is used when the contact has no
   first name. Available tags:
   - `first_name`, `last_name`, `full_name`, `email`, `company`;
   - any imported column, for example `{{ attribs.city }}`.
5. MailHarbor saves as you type. **Preview** shows the email as a sample contact would see it.

Every email automatically includes an unsubscribe link and your organisation's postal address. If you remove the
unsubscribe link from the template, MailHarbor adds a footer anyway.

### The drag-and-drop builder
New campaigns open in the builder. It has three parts:

| Part | What it does |
|---|---|
| **Blocks** (left) | Heading, Text, Button, Image, Two columns, Divider, Spacer, HTML |
| **The email** (centre) | Shows the content as it will look. Click into headings, text and buttons and type |
| **Settings** (right) | Colours, alignment, links, image address and description, size and spacing of the selected block |

- **Add a block:** drag it from *Blocks* onto the email. A green line shows where it will land. On a phone or with a
  keyboard, select a block in the email, then tap or press a block name: the new block goes below the selected one.
- **Move a block:** drag its ⋮⋮ handle, or use the ↑ ↓ buttons on the block. The other buttons duplicate and delete it.
  **Undo** and **Redo** are above the email (Ctrl+Z / Ctrl+Y).
- **Format text:** select words in a text block, then use **B**, *I*, U, lists or the link button in Settings.
  Pasted text loses its formatting on purpose, because Word and web formatting breaks email layouts.
- **Two columns:** drag blocks into each column. On phones the columns stack automatically.
- **Images** are added by web address (https://…), for example from your website or file storage. Use JPG or PNG,
  about 1200px wide, and always fill in the description (alt text).
- The builder warns when text and background colours are hard to read. The *Ready to send* checklist also warns about
  buttons without a link and images without a description.

The template (Settings of the campaign → Template) adds the header and footer around the design; **Preview** shows both.

### Test, then send
1. Click **Send test** and enter up to 5 addresses. Check the email on your phone and on a computer, and click every link.
2. The **Ready to send** checklist must be all green: subject, sender, lists, content, postal address, public address
   and at least one eligible recipient.
3. Click **Send now**, or **Schedule** for a date and time (South African time).

While a campaign is sending you can:
- **Pause** and **Resume** it;
- **Cancel** it: people who have not received it yet will not get it.

If the mail server stops responding, MailHarbor **pauses the campaign automatically** and alerts the administrators.
Nothing is lost: once the problem is fixed, press **Resume**.

### Read the results
Open the campaign, or go to **Reports**:

| Measure | What it means |
|---|---|
| Recipients | Everyone the campaign was addressed to |
| Sent | Accepted by the mail server |
| Failed / skipped | Rejected, or became suppressed before their turn |
| Hard / soft bounces | Address doesn't exist / temporary problem |
| Complaints | Marked as spam |
| Unsubscribes | Opted out from this email |
| Unique opens / clicks | People who opened / clicked at least once |

The report also lists the **top links** and a timeline.

Benchmarks:
- A bounce rate above **2%** deserves attention. Above **5%**, the list needs cleaning.
- Complaints should stay below **0.1%**.
- Opens are only indicative: Apple Mail and security scanners open emails automatically, and many people block images.
  Clicks are more reliable.

**Reports → Audience & bounces** shows:
- where contacts come from;
- their consent basis;
- growth;
- bounce trends by day, code and domain.

### Review queue
When a mail server rejects an email as **policy or spam** (code 5.7.x), the person is not wrongly marked as bounced. They
are **held for review** and receive nothing until someone decides:
- **Release**: it was a temporary block or a content problem;
- **Suppress**: the address really should not be emailed.

If many contacts at the same domain appear here, the problem is usually your sending reputation, not those people.
Tell your administrator.

### Templates
**Templates** holds the frame around your content (logo, colours, footer). Write campaign content where the template
contains `{{ content }}`. Mark one template as the **default** for new campaigns.

## Exports
**Exports** offers:
- contacts (for any filter);
- eligible contacts;
- the suppression list;
- consent and unsubscribe history;
- status history;
- bounces;
- campaigns.

Files are CSV and open in Excel. Each export is recorded in the audit log.

## Statuses

| Status | Meaning | Gets campaigns? |
|---|---|---|
| Active | Valid and subscribed | Yes |
| Soft bounced | Temporary failure; suppressed after the limit (default 3) | Yes, until the limit |
| Unconfirmed | Hasn't confirmed a double opt-in | No |
| Pending review | Held after a policy/spam rejection | No |
| Hard bounced | Address doesn't exist (or soft-bounce limit reached) | No (suppressed) |
| Complaint | Marked as spam | No (suppressed) |
| Unsubscribed | Opted out | No (suppressed) |
| Blocklisted | Suppressed manually | No |
| No lists | On no list | No |

## Roles

| Role | Can |
|---|---|
| Viewer | View dashboards, contacts, lists, campaigns and reports (read-only, no exports) |
| Manager | Everything a viewer can, plus: add and edit contacts and lists, import, export, write and send campaigns, edit templates, unsubscribe, suppress, resolve reviews, view System health |
| Administrator | Everything a manager can, plus: Settings, users, reactivate suppressed contacts, erase contacts, delete lists, audit log |

## FAQ

- **A contact I imported isn't on the list.**
  Check the row report in *Import history*. The contact was probably suppressed, had unsubscribed from that list
  before, or had no consent basis.
- **Why can't I re-add someone who unsubscribed?**
  By design. They must opt in again, or an administrator records new consent.
- **Can recipients see each other?**
  No. Every person receives an individual email.
- **A tag showed as empty.**
  The contact has no value for it. Add a fallback: `{{ first_name | "there" }}`.
- **Some export values start with an apostrophe.**
  Values beginning with `= + - @` are prefixed so that spreadsheets cannot run them as formulas.
- **I forgot my password.**
  Ask an administrator to reset it (Users → Edit).
