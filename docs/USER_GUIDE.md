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

### Segments
A segment is a saved set of rules that keeps itself up to date, for example *Last opened in the last 90 days* AND
*Imported column "city" is Durban*. Go to **Segments → New segment** and add conditions:

| Condition | Examples |
|---|---|
| Status | is Active, is Eligible to receive |
| List | is subscribed to "Newsletter" |
| Source, Consent method, Email domain, Company, First name | source is "Expo 2026"; domain ends with ".co.za" |
| Imported column | "city" is Durban; "branch" has a value |
| Added, Last opened, Last clicked, Last emailed | in the last 90 days; never; on or after a date |
| Soft bounces | at least 2 |

Choose whether contacts must match **all** or **any** of the conditions. The live preview shows how many contacts
match and how many can receive email.

Use a segment in three places:
- **View contacts** filters the contact list. Exports follow the same filter.
- **Contacts** has a *Segment* filter.
- **Campaigns → Narrow to a segment** sends only to people who are on the campaign's lists **and** in the segment.

Segments never add anyone who isn't subscribed: list membership carries the permission to email.

### Sign-up forms
Go to **Sign-up forms → New form**:
1. Name the form and choose the list(s) people join.
2. Choose the fields (first name, last name, company: hidden, optional or required).
3. Set the heading, intro, consent statement, button text and colour, and a thank-you message. You can send people to
   your own thank-you page instead.
4. Save. You get a **link**, for emails, social media or a QR code, and **embed code** to paste into your website.

What happens when someone signs up:
- A new contact is created, or an existing one updated: blank names are filled in, nothing is overwritten.
- Their **consent is recorded**: the statement they ticked, the form, the date, time and IP address.
- **Single opt-in** lists add them straight away.
- **Double opt-in** lists send a confirmation email first; they join when they click *Confirm*.
- **Protected:** someone who unsubscribed or bounced is **not** re-subscribed, and the form shows the same thank-you
  message, so nobody can find out whether an address is on your database.
- Bots are filtered out automatically. The form page shows recent sign-ups and how many were blocked as spam.

To stop sign-ups, set the form to **Closed**.

### Images
**Images** is your library of logos, banners and product photos. Upload up to 10 at a time, by button or drag and
drop. MailHarbor:
- resizes each image for email (at most 1200px wide);
- turns phone photos the right way up;
- removes hidden photo data such as GPS location;
- compresses the image, typically by 80–95%.

In the builder, select an image block and press **Choose or upload an image**. The image's name fills in its
description (alt text); improve it if you can. An image used in a campaign or as your logo can't be deleted, because emails
that were already sent still show it.

### Update or remove someone
Open the contact:
- **Edit** to change details;
- **Actions → Manage lists / Record consent / Unsubscribe / Suppress**;
- **Data export** for "what do you hold about me?" requests;
- **Erase** (administrators) for POPIA deletion requests.

The contact page also lists every email sent to the person, with opens, clicks and bounces.

For an opt-out request by phone or email, use **Actions → Unsubscribe** and note how the request arrived.

## Campaigns

### How a campaign is put together
Every email has the same structure, so a campaign is only its content:

| Part | Where it comes from |
|---|---|
| Header: your logo, or your organisation name | **Settings → Email design** (administrators) |
| Content: headings, text, images, buttons… | The campaign, built in the drag-and-drop builder |
| Footer: organisation name and postal address, a footer line, Unsubscribe · Manage preferences · View in browser | **Settings → General** and **Email design** |
| Sender (From, Reply-to) | **Settings → Sending**, unless the campaign sets its own |

Headings, buttons and links use your brand colours unless you pick a colour for a block. When a campaign is sent, its
content and design are frozen: changing the design later never changes emails that were already sent.

### Write
Go to **Campaigns → New campaign** and pick a starting design:

| Sample | Use it for |
|---|---|
| Simple message | A greeting, a paragraph and a button |
| Marketing promotion | Specials: banner, headline offer, two featured products, call to action |
| New product release | Announcing something new: hero image, key features, "Find out more" |
| Are you still interested? | Re-engaging quiet contacts: one button to stay, an easy unsubscribe |
| Introduction & permission request | Introducing yourself to new contacts and asking if you may keep emailing them (see below) |
| Want to find out more? | Following up interest: benefits, a customer quote, "Book a call" |
| Monthly newsletter | A lead story, two stories side by side, quick news items |
| Event invitation | Date, time, venue and an RSVP button |
| Welcome new subscribers | Saying hello and setting expectations |

The editor has three steps:

1. **Audience.** Tick the lists, and optionally narrow them to a saved segment. The count shows **how many people will
   receive it**, already excluding suppressed, unconfirmed and held contacts.
2. **Email.**
   - **Subject** and **Preview text** (the grey text next to the subject in the inbox).
   - **Campaign name**: internal, used in reports.
   - **From**: shows the sender from Settings. Open it only to use a different sender for this campaign.
   - **Tracking**: opens, clicks and Google Analytics tags are on by default. Open it to switch them off or rename the
     campaign in Google Analytics.
   - **Content**: build the email in the builder (see below). **Start from a sample** replaces the content with a
     ready-made design; Undo brings the previous one back.
3. **Review & send.** The checklist on the right lists anything still missing, for example a subject line or a button
   without a link. **Preview** shows the email exactly as a recipient sees it, with your header and footer.

**Personalise** with the quick-click field buttons: **First name**, **Full name**, **Last name**, **Company**,
**Email**, **Your organisation**, plus your own imported columns (for example **City**). Click where the name should go
(in the subject, preview text, a heading, text or a button), then click the field: it is inserted right there, as a
tag such as `{{ first_name | "there" }}`. The text after `|` is used when a contact has no first name. The Preview
shows real names.

MailHarbor saves as you type. The plain-text version of the email is generated automatically.

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
- **Where a button or link goes:** select the button (or select words and press the link button) and choose:

  | Goes to | What happens |
  |---|---|
  | A web address | Your website or any page; clicks are tracked |
  | Unsubscribe page | The person unsubscribes in one step |
  | Manage preferences | The person sees their lists, unticks the ones they don't want, or unsubscribes from everything |
  | Stay subscribed | The person confirms they still want your emails ("Are you still interested?" campaigns) |
  | Give permission | The person agrees that you may email them. Recorded on the contact as consent, with the campaign, time and IP address |
  | View in browser | Opens the email as a web page |

  For everything except a web address, MailHarbor creates each person's own link when it sends. There's nothing to
  copy or set up. Everything those pages do is recorded on the contact and in the campaign report.
- The builder warns when text and background colours are hard to read. The *Review & send* checklist also warns about
  web-address buttons without a link and images without a description.
- Need raw HTML? Use the **HTML** block. Scripts and unsafe code are removed when it's saved.

### Test, then send
1. Click **Send test** and enter up to 5 addresses. Check the email on your phone and on a computer, and click every link.
2. The **Review & send** checklist must be all green: subject, sender, lists, content, postal address, public address
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
| Stayed subscribed | Confirmed on the "stay subscribed" page (shown when the campaign used it) |
| Gave permission | Said yes on the permission page (shown when the campaign used it) |
| Preference changes | Changed their lists on the preference page (shown when used) |

**Every number opens the people behind it.** Click *Hard bounces* to see who bounced and why, *Unique clicks* to see
who clicked, or a link's *People* count to see who clicked that link. Each list shows delivery status, opens, clicks,
bounces and what the person did, links to the contact, and can be downloaded as CSV (managers and administrators).

The report also lists the **top links** and a timeline.

**Mail usage** (menu → Insights) shows everything MailHarbor sends through your SMTP server:
- emails sent today, this month and in the last hour, compared with your hourly limit;
- emails waiting to be sent;
- emails per day by kind (campaigns, opt-in confirmations, tests);
- emails your SMTP server rejected;
- what recipients did (unsubscribed, changed preferences, stayed subscribed, confirmed opt-in);
- which campaigns were sent.

Every number and every day in the chart opens the emails behind it. Compare these numbers with your SMTP provider's
limits.

**Google Analytics.** Links in your campaigns get UTM tags automatically. For example, `?utm_source=mailharbor&utm_medium=email&utm_campaign=november-specials`.
In Google Analytics you then see visits and sales from each campaign under *Traffic acquisition*, as
*mailharbor / email*. Under the campaign's **Tracking** options you can switch tags off, or give the campaign its own name in Google
Analytics. Administrators set the defaults, or limit tagging to your own website, in **Settings → Sending**.

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

Here too, every number opens its contacts or bounces: a source, a consent method, a month's growth, a bounce code or
a domain.

### Review queue
When a mail server rejects an email as **policy or spam** (code 5.7.x), the person is not wrongly marked as bounced. They
are **held for review** and receive nothing until someone decides:
- **Release**: it was a temporary block or a content problem;
- **Suppress**: the address really should not be emailed.

If many contacts at the same domain appear here, the problem is usually your sending reputation, not those people.
Tell your administrator.

### Email design (administrators)
**Settings → Email design** sets the look of every email:
- **Logo**: choose one from Images or paste its address, with its width and position. Without a logo, your
  organisation name is shown.
- **Brand colour** (buttons and links), **heading colour** and **background**.
- **Font**: email-safe fonts that every device has.
- **Footer line** under your name and address, and whether to show a *Manage preferences* link. The unsubscribe and
  *View in browser* links are always included.

The preview updates as you change things; press **Save settings** to apply. Drafts and future campaigns use the new
design. Campaigns already sent keep the design they were sent with.

## Inbox: replies to your campaigns

When someone presses **Reply** on a campaign, their email arrives in the **Inbox** (menu → Email), linked to the
contact and to the campaign they answered. The menu badge shows how many are unread.

**Views:** *Needs reply* (open conversations), *Mine*, *Unassigned*, *Unsubscribe requests*, *Auto-replies*
(out-of-office messages, filed separately and never counted as needing a reply), *Closed* and *All*. Search finds names,
addresses, subjects and text.

**Reading.** The reply shows what the person wrote; the quoted original email is folded away (*Show quoted text*).
*Show original formatting* displays the email as it was sent, safely isolated; remote images (often tracking pixels)
stay blocked until you press *Load images*. Attachments are listed for download.

**Answering** (managers and administrators):
- Write in the box under the conversation. It starts with a greeting and your signature. **Send reply** emails the person
  from your sender address, threaded with their message in their mail client; **Send and close** also closes the
  conversation. If they answer again, it joins the same conversation and reopens it.
- **Internal note**: notes for your team, never emailed.
- **Assign** a conversation to a colleague, **Close** it when done, or mark it unread again.
- **Unsubscribe requests**: replies like "please remove me" are flagged in red. Press **Unsubscribe** to opt the person
  out; it is recorded on the contact with the conversation as the reason, and the conversation closes. POPIA requires
  you to honour these, so check this view daily.
- A suppressed person can still be answered (for example a question), but don't use the reply to market to them.

Each campaign report has a **Replies** number that opens that campaign's conversations, and each contact page lists the
person's conversations. Replies are part of POPIA access requests (data export) and are deleted when a contact is erased.

If the Inbox says replies aren't being collected, an administrator needs to connect the replies mailbox
(Settings → Replies).

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
| Viewer | View dashboards, contacts, lists, campaigns, reports and the Inbox (read-only, no exports or replies) |
| Manager | Everything a viewer can, plus: add and edit contacts and lists, import, export, write and send campaigns, answer replies in the Inbox, manage images, unsubscribe, suppress, resolve reviews, view System health |
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
