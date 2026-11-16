import { html, raw, mount } from '../ui.js';

// In-app user guides. Static, trusted content.
const G = {
  start: ['Getting started', raw(`
    <h2>Getting started with MailHarbor</h2>
    <p>MailHarbor is where you <strong>manage your contact database</strong>: import it, sort it, keep it clean and prove consent.
    Emails themselves are written and sent in <strong>listmonk</strong>, the sending engine underneath. The two share one database, so anything you do here is
    instantly visible there, and every bounce or unsubscribe from listmonk flows back here automatically.</p>
    <h3>Your first 15 minutes</h3>
    <ol>
      <li><strong>Check System health</strong> (administrators): the go-live checklist must be green before you send. It checks SMTP, bounce processing, the unsubscribe header and HTTPS.</li>
      <li><strong>Create your lists</strong> under <a href="#/lists">Lists</a>, e.g. "Newsletter" or "Customers – Gauteng".</li>
      <li><strong>Import your contacts</strong> from a CSV file under <a href="#/import">Import</a>. You will see exactly what will happen before anything is saved.</li>
      <li><strong>Review the result</strong> on the <a href="#/contacts">Contacts</a> page. Filter by list, source, status or consent.</li>
      <li><strong>Send a campaign</strong> in listmonk (button at the bottom-left), then watch the results under <a href="#/campaigns">Campaign reports</a>.</li>
    </ol>
    <div class="tip"><strong>The golden rule:</strong> once someone unsubscribes, bounces permanently or complains, they are suppressed. Nothing (not an import, a list change or an edit in listmonk) can quietly email them again. Only an administrator can reactivate them, with documented new consent.</div>
    <h3>Where things live</h3>
    <ul><li><strong>MailHarbor:</strong> contacts, imports, exports, lists, suppression, consent, reports, users.</li>
      <li><strong>listmonk:</strong> email templates, writing campaigns, test sends, scheduling, SMTP and bounce-mailbox settings.</li></ul>`)],

  importing: ['Importing contacts', raw(`
    <h2>Importing contacts from a spreadsheet</h2>
    <h3>1. Prepare the file</h3>
    <ul><li>Save it as <strong>CSV (UTF-8)</strong>. In Excel: <em>File → Save As → CSV UTF-8</em>.</li>
      <li>The first row must hold column names. One column must contain email addresses.</li>
      <li>Useful columns: <code>first_name</code>, <code>last_name</code>, <code>company</code>, <code>source</code>, <code>consent_method</code>, <code>consent_date</code> (YYYY-MM-DD or DD/MM/YYYY), <code>consent_purpose</code>.</li>
      <li>Any other column (e.g. <code>city</code>, <code>account_manager</code>) becomes a custom attribute you can use for personalisation, e.g. <code>{{ .Subscriber.Attribs.city }}</code> in listmonk.</li>
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
      <tr><td><span class="status s-soft_bounced">Soft bounced</span></td><td>A temporary failure (mailbox full, server busy). listmonk retries; after the configured number of soft bounces the contact is blocked.</td><td>Yes, until the limit</td></tr>
      <tr><td><span class="status s-unconfirmed">Unconfirmed</span></td><td>On a double opt-in list but has not clicked the confirmation link.</td><td>No</td></tr>
      <tr><td><span class="status s-pending_review">Pending review</span></td><td>Held because a server rejected mail for a policy/spam reason. A person must decide. See the <a href="#/review">Review queue</a>.</td><td>No</td></tr>
      <tr><td><span class="status s-hard_bounced">Hard bounced</span></td><td>The address does not exist. Suppressed.</td><td>No</td></tr>
      <tr><td><span class="status s-complaint">Complaint</span></td><td>The person marked an email as spam. Suppressed immediately.</td><td>No</td></tr>
      <tr><td><span class="status s-unsubscribed">Unsubscribed</span></td><td>Opted out. Suppressed from all marketing lists.</td><td>No</td></tr>
      <tr><td><span class="status s-blocklisted">Blocklisted</span></td><td>Suppressed manually or in listmonk.</td><td>No</td></tr>
      <tr><td><span class="status s-no_lists">No lists</span></td><td>Not on any list.</td><td>No</td></tr></tbody></table>
    <h3>Finding and sorting</h3>
    <p>Use the search box (email, name or company) and the filters for status, list, source and consent. Click any column heading to sort. Choose <em>Eligible to receive</em> to see exactly who your next campaign will reach.</p>
    <h3>Bulk actions</h3><p>Tick contacts to add them to or remove them from lists, unsubscribe or suppress them. People who once unsubscribed from a list are never re-added to it.</p>
    <h3>A contact's page</h3><p>Shows profile, lists, consent evidence, bounce details (with the mail server's reason) and a full history of every change.</p>`)],

  campaigns: ['Sending a campaign', raw(`
    <h2>Sending a campaign (in listmonk)</h2>
    <ol>
      <li>Click <strong>New campaign in listmonk</strong> (bottom-left). Sign in with your listmonk account.</li>
      <li>Enter a name, subject and <strong>From address</strong>, and choose the list(s). Suppressed, unsubscribed and unconfirmed contacts are excluded automatically.</li>
      <li>Pick a template and write your content. Personalise with <code>{{ .Subscriber.FirstName }}</code> or attributes such as <code>{{ .Subscriber.Attribs.company }}</code>.</li>
      <li>Keep the unsubscribe link: templates include <code>{{ UnsubscribeURL }}</code>. Never remove it.</li>
      <li>Use <strong>Send test</strong> to send to yourself, check the preview on mobile, then <strong>Schedule</strong> or <strong>Start</strong>.</li>
      <li>Each person receives their own individual email; nobody sees other recipients.</li>
    </ol>
    <p>Progress, bounces, unsubscribes, opens and clicks appear in <a href="#/campaigns">Campaign reports</a>. You can pause or cancel a running campaign in listmonk.</p>
    <div class="tip">Start new or old lists with a small batch. A high bounce rate in the first hour is a sign the list needs cleaning before you continue.</div>`)],

  bounces: ['Bounces explained', raw(`
    <h2>How bounces are handled</h2>
    <p>When an email cannot be delivered, the receiving server sends a failure notice to a <strong>dedicated bounce mailbox</strong>. listmonk reads that mailbox (or receives provider webhooks) and records the bounce.
    MailHarbor then classifies it using the SMTP status code:</p>
    <table class="table table-sm"><thead><tr><th>Server response</th><th>Classification</th><th>What happens</th></tr></thead><tbody>
      <tr><td>550, 5.1.1 user unknown, 5.1.2 bad domain, 5.4.4 no mail server</td><td>Hard bounce</td><td>Suppressed permanently</td></tr>
      <tr><td>4.x.x temporary failure, 4.2.2 / 5.2.2 mailbox full</td><td>Soft bounce</td><td>Recorded; blocked after the configured number</td></tr>
      <tr><td>5.7.x policy / spam / authentication rejection</td><td>Review</td><td>Held from sending until a person decides</td></tr>
      <tr><td>Spam complaint (feedback loop)</td><td>Complaint</td><td>Suppressed immediately</td></tr></tbody></table>
    <h3>Why "review"?</h3><p>A 5.7.1 rejection usually means the receiving server did not like the <em>message or our sending setup</em> (e.g. SPF/DKIM/DMARC), not that the mailbox is missing. Suppressing such addresses would wrongly lose good contacts, so they are held and appear in the <a href="#/review">Review queue</a>. If many appear at once, check your domain's DNS before releasing them.</p>
    <div class="warn">If bounce processing stops (for example the bounce mailbox password changed), a red alert appears on the dashboard. Fix it promptly: until then invalid addresses are not being suppressed.</div>`)],

  suppression: ['Suppression & reactivation', raw(`
    <h2>The suppression list</h2>
    <p>The <a href="#/suppression">suppression list</a> is the permanent record of addresses that must not receive marketing: hard bounces, complaints, unsubscribes and manual blocks.</p>
    <ul><li>It is checked on every import, list change and contact creation.</li>
      <li>Every few minutes MailHarbor also checks listmonk: if a suppressed contact was re-enabled there by hand, it is blocked again and an alert is raised.</li>
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
      <tr><td><strong>Unsubscribes (7 days)</strong></td><td>Unsubscribes from the campaign's lists within a week of sending.</td></tr>
      <tr><td><strong>Opens</strong></td><td><em>Indicative only.</em> Apple Mail Privacy Protection and security scanners inflate opens; image blocking hides them.</td></tr>
      <tr><td><strong>Clicks</strong></td><td>The most reliable engagement signal.</td></tr></tbody></table>
    <h3>Audience & bounces</h3><p>Shows where contacts came from, their consent basis, growth, and bounce trends. A source with a high bounce rate is a sign of an old or purchased list.</p>`)],

  popia: ['Exports & POPIA', raw(`
    <h2>Exports and POPIA requests</h2>
    <h3>Everyday exports</h3><p>Under <a href="#/exports">Exports</a> you can download contacts, the suppression list, consent history, status history, bounces and campaign reports as CSV files. Every export is logged.</p>
    <h3>Access request ("what do you hold about me?")</h3><p>Open the contact and click <strong>Data export</strong>. You get a file with their profile, lists, consent records, bounces, engagement and history.</p>
    <h3>Deletion request</h3><p>Administrators open the contact and click <strong>Erase</strong>. The contact is deleted from listmonk and personal details are removed from MailHarbor, keeping only a one-way code on the suppression list so the person is never contacted again.</p>
    <h3>Opt-out by phone or email</h3><p>Open the contact → Actions → <strong>Unsubscribe</strong>, and note how the request arrived.</p>
    <h3>Proving consent</h3><p>Download <em>Consent & unsubscribe history</em>. It shows how and when each permission was obtained or withdrawn, and who recorded it.</p>
    <div class="warn">MailHarbor supports POPIA compliance but does not make you compliant by itself. Your marketing practices and any reliance on the existing-customer exception (s69(3)) should be reviewed by your information officer.</div>`)],

  deliverability: ['Deliverability setup', raw(`
    <h2>Deliverability: getting into the inbox</h2>
    <p>Your sending domain needs these DNS records. Your IT provider or mail host sets them up once.</p>
    <table class="table table-sm"><tbody>
      <tr><td><strong>SPF</strong></td><td>Lists the servers allowed to send for your domain.</td></tr>
      <tr><td><strong>DKIM</strong></td><td>Cryptographically signs each email.</td></tr>
      <tr><td><strong>DMARC</strong></td><td>Tells receivers what to do when SPF/DKIM fail. Start with <code>p=none</code> and a reporting address.</td></tr>
      <tr><td><strong>Return-Path</strong></td><td>Must point at the dedicated bounce mailbox so failures are captured.</td></tr>
      <tr><td><strong>Reverse DNS (PTR)</strong></td><td>Your sending server's IP must resolve to its hostname.</td></tr></tbody></table>
    <ul><li>Gmail and Yahoo require a one-click unsubscribe header for bulk mail: enabled in listmonk → Settings → Privacy.</li>
      <li>Send at a steady, moderate rate (listmonk → Settings → Performance), especially from a new domain.</li>
      <li>Never buy lists. Remove contacts who have not engaged for a long time.</li></ul>
    <div class="tip">There is no reliable way to check that a mailbox exists without sending to it. The real delivery result is the source of truth, which is exactly what MailHarbor tracks.</div>`)],

  roles: ['Users & roles', raw(`
    <h2>Users and roles</h2>
    <table class="table table-sm"><thead><tr><th>Role</th><th>Can</th></tr></thead><tbody>
      <tr><td><strong>Viewer</strong></td><td>See the dashboard, contacts, lists and reports. Cannot change anything or export personal data.</td></tr>
      <tr><td><strong>Manager</strong></td><td>Everything a viewer can, plus add/edit contacts, manage lists, import, export, unsubscribe, suppress and resolve reviews.</td></tr>
      <tr><td><strong>Administrator</strong></td><td>Everything, plus manage users, lift suppressions, erase contacts, view the audit log.</td></tr></tbody></table>
    <p>Accounts lock for 15 minutes after 10 wrong passwords. Administrators reset passwords under <a href="#/users">Users</a>. listmonk logins are separate and are managed in listmonk → Users.</p>`)],

  faq: ['Troubleshooting', raw(`
    <h2>Troubleshooting & FAQ</h2>
    <h3>A contact I imported is not on the list</h3><p>Check the import's row report under <a href="#/imports">Import history</a>. They were probably suppressed, previously unsubscribed from that list, or had no consent basis.</p>
    <h3>Why can't I re-add someone who unsubscribed?</h3><p>By design. They must opt in again (e.g. via your website form), or an administrator must lift the suppression with evidence of new consent.</p>
    <h3>The dashboard says "Recipient sync has not run"</h3><p>The MailHarbor background process is not running or cannot reach the database. Ask your administrator to check the service logs.</p>
    <h3>"Bounce processing is not enabled"</h3><p>In listmonk → Settings → Bounces, enable bounce processing and configure the POP3 bounce mailbox. Use a mailbox dedicated to bounces: listmonk deletes messages after processing.</p>
    <h3>Excel shows strange characters</h3><p>Exports are UTF-8 with a byte-order mark and open correctly in current Excel. In older versions use <em>Data → From Text/CSV</em> and choose UTF-8.</p>
    <h3>Some values in an export start with an apostrophe</h3><p>Values that begin with <code>=</code>, <code>+</code>, <code>-</code> or <code>@</code> are prefixed with <code>'</code> so spreadsheets cannot run them as formulas (a security protection).</p>`)],
};

export async function render(el, ctx, [topic]) {
  const key = G[topic] ? topic : 'start';
  mount(el, html`<div class="page-head"><div><h1>Guides</h1><p>Short, practical help for everyday tasks.</p></div></div>
    <div class="row g-3"><div class="col-lg-3"><div class="card"><div class="card-body guide-nav p-2">
      ${Object.entries(G).map(([k, [t]]) => html`<a href="#/guides/${k}" class="${k === key ? 'active' : ''}">${t}</a>`)}</div></div></div>
    <div class="col-lg-9"><div class="card"><div class="card-body guide p-4">${G[key][1]}</div></div></div></div>`);
}
