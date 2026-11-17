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
description (alt text); improve it if you can. An image used in a campaign or template can't be deleted, because emails
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

### Write
1. Go to **Campaigns → New campaign** (or the button at the bottom-left) and pick a starting design:

   | Sample | Use it for |
   |---|---|
   | Simple message | A greeting, a paragraph and a button |
   | Marketing promotion | Specials: banner, headline offer, two featured products, call to action |
   | New product release | Announcing something new: hero image, key features, "Find out more" |
   | Are you still interested? | Re-engaging quiet contacts: one button to stay, an easy unsubscribe |
   | Want to find out more? | Following up interest: benefits, a customer quote, "Book a call" |
   | Monthly newsletter | A lead story, two stories side by side, quick news items |
   | Event invitation | Date, time, venue and an RSVP button |
   | Welcome new subscribers | Saying hello and setting expectations |

   Each sample also picks its **matching template**:
   - Marketing promotion and Event invitation use **Promotion**;
   - New product release uses **New release**;
   - the others use **Clean**;
   - Simple message uses your default template.

   The gallery shows which template each sample uses, and you can change it in the envelope section.
   Every sample is fully editable. Replace the [bracketed] text and add your images and links; the *Ready to send*
   checklist reminds you about buttons that still need a link. To switch an existing draft to a sample, use
   **Samples** above the builder (Undo brings your previous design back). Give the campaign an internal name and
   choose a template.
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
4. **Personalise** with the quick-click field buttons: **First name**, **Full name**, **Last name**, **Company**,
   **Email**, **Your organisation**, plus your own imported columns (for example **City**). Click where the name should go
   (in the subject, preview text, a heading, text or a button), then click the field: it is inserted right there, as a
   tag such as `{{ first_name | "there" }}`. The text after `|` is used when a contact has no first name. The buttons are
   under the preview text (for the subject) and above the email (for the content). The Preview shows real names.
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
- **Where a button or link goes:** select the button (or select words and press the link button) and choose:

  | Goes to | What happens |
  |---|---|
  | A web address | Your website or any page; clicks are tracked |
  | Unsubscribe page | The person unsubscribes in one step |
  | Manage preferences | The person sees their lists, unticks the ones they don't want, or unsubscribes from everything |
  | Stay subscribed | The person confirms they still want your emails ("Are you still interested?" campaigns) |
  | View in browser | Opens the email as a web page |

  For everything except a web address, MailHarbor creates each person's own link when it sends. There's nothing to
  copy or set up. Everything those pages do is recorded on the contact and in the campaign report.
- The builder warns when text and background colours are hard to read. The *Ready to send* checklist also warns about
  web-address buttons without a link and images without a description.

The campaign's **Template** (in the envelope section) adds the header and footer around the design; **Preview** shows both.

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
| Stayed subscribed | Confirmed on the "stay subscribed" page (shown when the campaign used it) |
| Preference changes | Changed their lists on the preference page (shown when used) |

The report also lists the **top links** and a timeline.

**Mail usage** (menu → Insights) shows everything MailHarbor sends through your SMTP server:
- emails sent today, this month and in the last hour, compared with your hourly limit;
- emails waiting to be sent;
- emails per day by kind (campaigns, opt-in confirmations, tests);
- emails your SMTP server rejected;
- what recipients did (unsubscribed, changed preferences, stayed subscribed, confirmed opt-in);
- which campaigns were sent.

Compare these numbers with your SMTP provider's limits.

**Google Analytics.** Links in your campaigns get UTM tags automatically. For example, `?utm_source=mailharbor&utm_medium=email&utm_campaign=november-specials`.
In Google Analytics you then see visits and sales from each campaign under *Traffic acquisition*, as
*mailharbor / email*. In the campaign's envelope you can switch tags off, or give the campaign its own name in Google
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

### Review queue
When a mail server rejects an email as **policy or spam** (code 5.7.x), the person is not wrongly marked as bounced. They
are **held for review** and receive nothing until someone decides:
- **Release**: it was a temporary block or a content problem;
- **Suppress**: the address really should not be emailed.

If many contacts at the same domain appear here, the problem is usually your sending reputation, not those people.
Tell your administrator.

### Templates
**Templates** are the frame around every campaign: logo, name, colours, width, font and footer. They are designed in
the same drag-and-drop builder, with two extra blocks:

- **Campaign content**: marks where each campaign's design appears. A template has exactly one, and it cannot be
  deleted or put inside columns. Move it to place blocks above (header) and below (footer) it.
- **Footer**: your organisation name and postal address (from Settings → General), an optional extra line, and the
  unsubscribe and "View in browser" links.

Click empty space next to the email for **Page settings**: page background, content background, email width, font,
content corners and padding. The preview shows the template around sample content and refreshes as you work.
Press **Save** to keep your changes. Unlike campaigns, templates do not save automatically, because a template change
affects every campaign that uses it.

**Ready-made templates.** MailHarbor comes with four designs, marked *Ready-made* in the list:

| Template | Look | Best for |
|---|---|---|
| MailHarbor standard | Light grey page, your name on top, white card | Everyday emails (the default) |
| Clean | White and minimal, thin dividers | Updates, newsletters, personal notes |
| Promotion | Bold navy page, "limited-time offers" banner, white card | Specials, sales, events |
| New release | Light modern page, "new release" label, rounded card | Product launches, announcements |

Make them yours: open one, select the image at the top and paste your logo's web address, then adjust colours and the
footer line. **New template** opens the same gallery, so you can start another design from any of them. If you delete
a ready-made template it stays deleted; campaign samples that used it fall back to your default template.

Mark one template as the **default** for new campaigns. Templates written in HTML still work: use the **HTML** tab
(the code must contain `{{ content }}`).

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
