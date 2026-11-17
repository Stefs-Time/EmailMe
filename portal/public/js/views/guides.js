import { html, raw, mount } from '../ui.js';

// In-app user guides. Static, trusted content.
const G = {
  start: ['Getting started', raw(`
    <h2>Getting started with MailHarbor</h2>
    <p>MailHarbor is your complete email marketing system: it holds your <strong>contact database</strong>, sends your
    <strong>campaigns</strong> through your own email server, and automatically handles <strong>bounces, unsubscribes and consent</strong>.</p>
    <h3>Your first 15 minutes</h3>
    <ol>
      <li><strong>Settings</strong> (administrators): add your postal address, sender address and the bounce mailbox. Then open
        <a href="#/system">System health</a>: every critical check should be green.</li>
      <li><strong>Create lists</strong> under <a href="#/lists">Lists</a>, e.g. "Newsletter" or "Customers – Gauteng".</li>
      <li><strong>Import contacts</strong> from a CSV file under <a href="#/import">Import</a>. You see exactly what will happen before anything is saved.</li>
      <li><strong>Write a campaign</strong> under <a href="#/campaigns">Campaigns</a>, send yourself a test, then send or schedule it.</li>
      <li><strong>Watch the results</strong> on the campaign page: delivery, bounces, opens, clicks and unsubscribes.</li>
    </ol>
    <div class="tip"><strong>The golden rule:</strong> once someone unsubscribes, bounces permanently or complains, they are suppressed. No import,
    list change or campaign can email them again. Only an administrator can reactivate them, with documented new consent.</div>`)],
  importing: ['Importing contacts', raw(`
    <h2>Importing contacts from a spreadsheet</h2>
    <h3>1. Prepare the file</h3>
    <ul><li>Save it as <strong>CSV (UTF-8)</strong>. In Excel: <em>File → Save As → CSV UTF-8</em>.</li>
      <li>The first row must hold column names. One column must contain email addresses.</li>
      <li>Useful columns: <code>first_name</code>, <code>last_name</code>, <code>company</code>, <code>source</code>, <code>consent_method</code>, <code>consent_date</code> (YYYY-MM-DD or DD/MM/YYYY), <code>consent_purpose</code>.</li>
      <li>Any other column (e.g. <code>city</code>, <code>account_manager</code>) becomes a custom attribute you can use for personalisation, e.g. <code>{{ attribs.city }}</code> in a campaign.</li>
      <li><a href="/samples/contacts-template.csv" download>Download the template</a> to start from.</li></ul>
    <h3>2. Match columns</h3>
    <p>MailHarbor guesses what each column is. Correct anything wrong, choose the lists, and set a <strong>consent basis</strong> for rows that have no consent column.</p>
    <h3>3. Review</h3>
    <p>Every row is checked and placed in one group:</p>
    <table class="table table-sm w-auto"><tbody>
      <tr><td><strong>New contact</strong></td><td>Will be created.</td></tr>
      <tr><td><strong>Existing – will be added to list(s)</strong></td><td>Already in the database; only joins the lists they have never been on. Their details and statuses are not changed.</td></tr>
      <tr><td><strong>Existing – no change</strong></td><td>Already on every selected list (or previously unsubscribed from it).</td></tr>
      <tr><td><strong>Suppressed – excluded</strong></td><td>Previously unsubscribed, bounced, complained or blocklisted. Never re-activated.</td></tr>
      <tr><td><strong>Invalid email / Duplicate in file / Invalid data</strong></td><td>Excluded. Download the rows, fix them, and import again.</td></tr>
      <tr><td><strong>No consent basis</strong></td><td>Excluded. Add a consent column or choose a default consent method.</td></tr></tbody></table>
    <h3>4. Import</h3><p>Click <em>Import</em>. Large files run in the background; you can leave the page. The result and a row-by-row report stay under <a href="#/imports">Import history</a>.</p>
    <div class="warn"><strong>Consent matters.</strong> Under POPIA, having someone's email address is not permission to market to them. Only choose a consent method you can prove.</div>`)],

  contacts: ['Contacts & statuses', raw(`
    <h2>Contacts and what each status means</h2>
    <p>Every contact has one clear status, worked out from their subscriptions, bounces and suppression record.</p>
    <table class="table table-sm"><thead><tr><th>Status</th><th>Meaning</th><th>Receives campaigns?</th></tr></thead><tbody>
      <tr><td><span class="status s-active">Active</span></td><td>Valid, subscribed contact.</td><td>Yes</td></tr>
      <tr><td><span class="status s-soft_bounced">Soft bounced</span></td><td>A temporary failure (mailbox full, server busy). Retried automatically; after the soft-bounce limit the contact is suppressed. A click clears the count.</td><td>Yes, until the limit</td></tr>
      <tr><td><span class="status s-unconfirmed">Unconfirmed</span></td><td>On a double opt-in list but has not clicked the confirmation link.</td><td>No</td></tr>
      <tr><td><span class="status s-pending_review">Pending review</span></td><td>Held because a server rejected mail for a policy/spam reason. A person must decide. See the <a href="#/review">Review queue</a>.</td><td>No</td></tr>
      <tr><td><span class="status s-hard_bounced">Hard bounced</span></td><td>The address does not exist. Suppressed.</td><td>No</td></tr>
      <tr><td><span class="status s-complaint">Complaint</span></td><td>The person marked an email as spam. Suppressed immediately.</td><td>No</td></tr>
      <tr><td><span class="status s-unsubscribed">Unsubscribed</span></td><td>Opted out. Suppressed from all marketing lists.</td><td>No</td></tr>
      <tr><td><span class="status s-blocklisted">Blocklisted</span></td><td>Suppressed manually.</td><td>No</td></tr>
      <tr><td><span class="status s-no_lists">No lists</span></td><td>Not on any list.</td><td>No</td></tr></tbody></table>
    <h3>Finding and sorting</h3>
    <p>Use the search box (email, name or company) and the filters for status, list, source and consent. Click any column heading to sort. Choose <em>Eligible to receive</em> to see exactly who your next campaign will reach.</p>
    <h3>Bulk actions</h3><p>Tick contacts to add them to or remove them from lists, unsubscribe or suppress them. People who once unsubscribed from a list are never re-added to it.</p>
    <h3>A contact's page</h3><p>Shows profile, lists, consent evidence, bounce details (with the mail server's reason) and a full history of every change.</p>`)],

  campaigns: ['Sending a campaign', raw(`
    <h2>Sending a campaign</h2>
    <ol>
      <li><a href="#/campaigns">Campaigns</a> → <strong>New campaign</strong>, then pick a starting design: a simple message, a marketing
        promotion, a new product release, "Are you still interested?", "Want to find out more?", a newsletter, an event invitation or a
        welcome email. Replace the [bracketed] text and add your images and links. <strong>Samples</strong> above the builder swaps the
        design of an existing draft (Undo brings it back).</li>
      <li><strong>Who receives it:</strong> tick one or more lists. The number of people who will actually receive it is shown underneath:
        suppressed, unsubscribed, unconfirmed and held contacts are left out automatically.</li>
      <li><strong>Envelope:</strong> subject line, preview text (the grey text inboxes show after the subject), sender and template.</li>
      <li><strong>Content:</strong> design the email in the drag-and-drop <em>Builder</em> (see below).</li>
      <li><strong>Personalise:</strong> click where the name should go (subject, preview text, a heading, text or button), then click a field
        button such as <em>First name</em>, <em>Full name</em> or <em>Company</em>. Your imported columns (e.g. <em>City</em>) appear as buttons too.
        Names are inserted with a fallback for contacts without one: <code>{{ first_name | "there" }}</code>. The preview shows real names.</li>
      <li>Check the <strong>preview</strong> on desktop and mobile, then <strong>Send test</strong> to yourself.</li>
      <li><strong>Send now</strong>, or <strong>Schedule</strong> for later. Changes save automatically while you type.</li>
    </ol>
    <p>Each person receives their own individual email; nobody sees other recipients. Every email includes your postal address, an unsubscribe
    link and the one-click unsubscribe header that Gmail, Yahoo and Outlook require.</p>
    <h3>The drag-and-drop builder</h3>
    <ul>
      <li><strong>Add:</strong> drag a block from <em>Blocks</em> onto the email. A green line shows where it will land. On a phone or with a
        keyboard, select a block in the email, then tap or press a block name to add the new one below it.</li>
      <li><strong>Edit:</strong> click into a heading, text or button and type. Select a block to change its colours, alignment, links,
        image, size and spacing in the panel on the right. Select words in a text block to make them bold, italic or a link.</li>
      <li><strong>Arrange:</strong> drag a block by its <i class="bi bi-grip-vertical"></i> handle, or use the arrows. Duplicate or delete it with the
        other buttons. <em>Undo</em> and <em>Redo</em> are above the email.</li>
      <li><strong>Two columns:</strong> drag blocks into each column. On phones the columns stack automatically.</li>
      <li><strong>Images</strong> are added by web address (https://…), for example from your website. Always give each image a
        short description for people who cannot see it.</li>
      <li>The builder warns you when text and background colours are hard to read, and the checklist warns about buttons without a link.</li>
    </ul>
    <h3>While it sends</h3>
    <p>The campaign page updates every few seconds. You can <strong>pause</strong>, <strong>resume</strong> or <strong>cancel</strong>. If your email server
    stops accepting mail, sending pauses automatically and an alert appears. Fix the problem, then press Resume.</p>
    <h3>Templates</h3>
    <p><a href="#/templates">Templates</a> are the frame around every campaign: logo, name, colours, width, font and footer. They use the same
    drag-and-drop builder, with two extra blocks: <strong>Campaign content</strong> (where each campaign appears; exactly one per template) and
    <strong>Footer</strong> (your organisation name, postal address, unsubscribe and "View in browser" links). Click empty space next to the email for
    <em>Page settings</em>. Press <em>Save</em> when done: template changes affect every campaign that uses the template.</p>
    <div class="tip">Start a new or old list with a small batch. A high bounce rate in the first hour is a sign the list needs cleaning before you continue.</div>`)],
  bounces: ['Bounces explained', raw(`
    <h2>How bounces are handled</h2>
    <p>MailHarbor learns about failed deliveries in three ways:</p>
    <ul>
      <li><strong>While sending:</strong> the receiving server refuses the address immediately (most hard bounces).</li>
      <li><strong>Bounce mailbox:</strong> some servers accept the email and send a failure notice later. MailHarbor reads these from the
        dedicated bounce mailbox set in Settings → Bounces, and also picks up spam complaints (feedback reports).</li>
      <li><strong>Provider webhook:</strong> if your email provider can post bounce events, they arrive directly.</li>
    </ul>
    <table class="table table-sm"><thead><tr><th>Server response</th><th>Classification</th><th>What happens</th></tr></thead><tbody>
      <tr><td>550, 5.1.1 user unknown, 5.1.2 bad domain, 5.4.4 no mail server</td><td>Hard bounce</td><td>Suppressed permanently</td></tr>
      <tr><td>4.x.x temporary failure, 4.2.2 / 5.2.2 mailbox full</td><td>Soft bounce</td><td>Retried, then counted; suppressed after the soft-bounce limit (default 3)</td></tr>
      <tr><td>5.7.x policy / spam / authentication rejection</td><td>Review</td><td>Held from sending until a person decides</td></tr>
      <tr><td>Spam complaint (feedback loop)</td><td>Complaint</td><td>Suppressed immediately</td></tr></tbody></table>
    <h3>Why "review"?</h3><p>A 5.7.1 rejection usually means the receiving server did not like the <em>message or your sending setup</em> (for example SPF/DKIM/DMARC),
    not that the mailbox is missing. These addresses are held and listed in the <a href="#/review">Review queue</a>. If many appear at once, check your DNS before releasing them.</p>
    <div class="warn">If the bounce mailbox cannot be read (for example its password changed), a red alert appears on the dashboard. Fix it promptly:
    until then, late bounces are not being recorded.</div>`)],
  suppression: ['Suppression & reactivation', raw(`
    <h2>The suppression list</h2>
    <p>The <a href="#/suppression">suppression list</a> is the permanent record of addresses that must not receive marketing: hard bounces, complaints, unsubscribes and manual blocks.</p>
    <ul><li>It is checked on every import, list change and contact creation.</li>
      <li>It is checked again immediately before each individual email is sent, so a contact who unsubscribes mid-campaign gets nothing more.</li>
      <li>You can suppress addresses that are not contacts yet (e.g. a legal request).</li></ul>
    <h3>Reactivating someone</h3>
    <p>Only <strong>administrators</strong> can lift a suppression, and only with:</p>
    <ol><li>a written reason, and</li><li>a new permission basis: how and when the person gave consent again, with evidence.</li></ol>
    <p>For hard bounces you must also confirm the address now works. Every reactivation is recorded in the audit log.</p>
    <p>Erased contacts (POPIA deletion) are kept only as a one-way code and cannot be reactivated. If they opt in again they are added as a new contact.</p>`)],

  reports: ['Reading the reports', raw(`
    <h2>Reading the reports</h2>
    <h3>Campaign metrics</h3>
    <table class="table table-sm"><tbody>
      <tr><td><strong>Recipients targeted</strong></td><td>Eligible contacts on the campaign's lists when it started.</td></tr>
      <tr><td><strong>Emails sent</strong></td><td>Messages handed to your mail server.</td></tr>
      <tr><td><strong>Delivery failures</strong></td><td>Hard + soft + review bounces. Above 2% deserves attention; above 5% means the list needs cleaning.</td></tr>
      <tr><td><strong>Complaints</strong></td><td>Spam reports. Keep this below 0.1%.</td></tr>
      <tr><td><strong>Unsubscribes</strong></td><td>People who unsubscribed using this campaign's link (exact).</td></tr>
      <tr><td><strong>Opens</strong></td><td><em>Indicative only.</em> Apple Mail Privacy Protection and security scanners inflate opens; image blocking hides them.</td></tr>
      <tr><td><strong>Clicks</strong></td><td>The most reliable engagement signal.</td></tr></tbody></table>
    <h3>Audience & bounces</h3><p>Shows where contacts came from, their consent basis, growth, and bounce trends. A source with a high bounce rate is a sign of an old or purchased list.</p>`)],

  popia: ['Exports & POPIA', raw(`
    <h2>Exports and POPIA requests</h2>
    <h3>Everyday exports</h3><p>Under <a href="#/exports">Exports</a> you can download contacts, the suppression list, consent history, status history, bounces and campaign reports as CSV files. Every export is logged.</p>
    <h3>Access request ("what do you hold about me?")</h3><p>Open the contact and click <strong>Data export</strong>. You get a file with their profile, lists, consent records, bounces, engagement and history.</p>
    <h3>Deletion request</h3><p>Administrators open the contact and click <strong>Erase</strong>. The contact and their personal details are deleted from MailHarbor, keeping only a one-way code on the suppression list so the person is never contacted again.</p>
    <h3>Opt-out by phone or email</h3><p>Open the contact → Actions → <strong>Unsubscribe</strong>, and note how the request arrived.</p>
    <h3>Proving consent</h3><p>Download <em>Consent & unsubscribe history</em>. It shows how and when each permission was obtained or withdrawn, and who recorded it.</p>
    <div class="warn">MailHarbor supports POPIA compliance but does not make you compliant by itself. Your marketing practices and any reliance on the existing-customer exception (s69(3)) should be reviewed by your information officer.</div>`)],

  deliverability: ['Deliverability setup', raw(`
    <h2>Deliverability: getting into the inbox</h2>
    <p>Your sending domain needs these DNS records. <a href="#/system">System health</a> checks SPF, DMARC and MX for you.</p>
    <table class="table table-sm"><tbody>
      <tr><td><strong>SPF</strong></td><td>Lists the servers allowed to send for your domain. Include your SMTP provider.</td></tr>
      <tr><td><strong>DKIM</strong></td><td>Cryptographically signs each email. Turn it on in your SMTP provider's dashboard for your domain.</td></tr>
      <tr><td><strong>DMARC</strong></td><td>Tells receivers what to do when SPF/DKIM fail. Start with <code>p=none</code> and a reporting address. Required by Gmail and Yahoo for bulk mail.</td></tr>
      <tr><td><strong>Bounce address</strong></td><td>A dedicated mailbox on your domain (Settings → Bounces) so failures come back to MailHarbor.</td></tr></tbody></table>
    <ul><li>Send at a steady, moderate rate (Settings → Sending): 2–5 per second on a new domain, more once your reputation is established.</li>
      <li>Never buy lists. Remove contacts who have not engaged for a long time.</li>
      <li>Keep the bounce rate under 2% and complaints under 0.1%.</li></ul>
    <div class="tip">There is no reliable way to check that a mailbox exists without sending to it. The real delivery result is the source of truth, which is exactly what MailHarbor tracks.</div>`)],
  roles: ['Users & roles', raw(`
    <h2>Users and roles</h2>
    <table class="table table-sm"><thead><tr><th>Role</th><th>Can</th></tr></thead><tbody>
      <tr><td><strong>Viewer</strong></td><td>See the dashboard, contacts, lists and reports. Cannot change anything or export personal data.</td></tr>
      <tr><td><strong>Manager</strong></td><td>Everything a viewer can, plus add/edit contacts, manage lists, import, export, unsubscribe, suppress and resolve reviews.</td></tr>
      <tr><td><strong>Administrator</strong></td><td>Everything, plus manage users, lift suppressions, erase contacts, view the audit log.</td></tr></tbody></table>
    <p>Accounts lock for 15 minutes after 10 wrong passwords. Administrators reset passwords under <a href="#/users">Users</a>; the environment-managed administrator is reset by changing <code>ADMIN_PASSWORD</code> (see <a href="#/guides/admin">For administrators</a>).</p>`)],

  admin: ['For administrators', raw(`
    <h2>For administrators</h2>
    <h3>What lives where</h3>
    <ul><li><strong>Hosting variables</strong> (e.g. Railway → Variables): only the database (<code>DATABASE_URL</code>) and the SMTP server
      (<code>SMTP_HOST</code>, <code>SMTP_PORT</code>, <code>SMTP_USER</code>, <code>SMTP_PASSWORD</code>, optionally <code>SMTP_FROM</code>).</li>
      <li><a href="#/settings">Settings</a>: organisation, postal address, sender, sending speed, bounce mailbox, webhook, compliance and backup alerts.</li></ul>
    <h3>Users and recovery</h3>
    <p>Create personal accounts under <a href="#/users">Users</a>. If every administrator is locked out, set <code>ADMIN_EMAIL</code> and <code>ADMIN_PASSWORD</code>
    in the hosting variables and redeploy: that account is created (or repaired) as an active administrator, and is shown as <em>Environment-managed</em>.</p>
    <h3>Bounce mailbox</h3>
    <p>Use a mailbox that receives nothing but bounces (for example <code>bounces@yourdomain</code>), set it as the bounce address, and connect it with IMAP.
    Processed messages are moved to a "MailHarbor-Processed" folder (or deleted). Never connect a personal inbox.</p>
    <h3>Backups</h3>
    <p><a href="#/system">System health</a> shows the last backup and raises an alert if it failed or is overdue. Set up and restore are described in the administrator guide.
    Test a restore at least once a quarter.</p>`)],
  faq: ['Troubleshooting', raw(`
    <h2>Troubleshooting & FAQ</h2>
    <h3>A contact I imported is not on the list</h3><p>Check the import's row report under <a href="#/imports">Import history</a>. They were probably suppressed, previously unsubscribed from that list, or had no consent basis.</p>
    <h3>Why can't I re-add someone who unsubscribed?</h3><p>By design. They must opt in again, or an administrator must lift the suppression with evidence of new consent.</p>
    <h3>My campaign paused by itself</h3><p>The email server stopped accepting mail (wrong password, server down, sending limit reached). The reason is shown on the campaign page and in System health. Fix it, then press Resume.</p>
    <h3>The test email did not arrive</h3><p>Check spam, then System health → SMTP server. Settings → Sending → "Send test email" shows the server's exact reply.</p>
    <h3>"The background worker is not running"</h3><p>The app process has stopped or is restarting. Check the hosting logs; emails resume automatically when it is back.</p>
    <h3>Excel shows strange characters</h3><p>Exports are UTF-8 and open correctly in current Excel. In older versions use <em>Data → From Text/CSV</em> and choose UTF-8.</p>
    <h3>Some values in an export start with an apostrophe</h3><p>Values that begin with <code>=</code>, <code>+</code>, <code>-</code> or <code>@</code> are prefixed with <code>'</code> so spreadsheets cannot run them as formulas (a security protection).</p>`)],
};

export async function render(el, ctx, [topic]) {
  const key = G[topic] ? topic : 'start';
  mount(el, html`<div class="page-head"><div><h1>Guides</h1><p>Short, practical help for everyday tasks.</p></div></div>
    <div class="row g-3"><div class="col-lg-3"><div class="card"><div class="card-body guide-nav p-2">
      ${Object.entries(G).map(([k, [t]]) => html`<a href="#/guides/${k}" class="${k === key ? 'active' : ''}">${t}</a>`)}</div></div></div>
    <div class="col-lg-9"><div class="card"><div class="card-body guide p-4">${G[key][1]}</div></div></div></div>`);
}
