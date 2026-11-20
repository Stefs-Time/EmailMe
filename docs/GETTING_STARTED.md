# Getting started with MailHarbor

MailHarbor is a hosted email marketing service. Your organisation gets its own private MailHarbor, with its own database
and web address. We run, update, monitor and back it up. Your emails go out through **your own mail server**, so your
sending reputation stays yours.

## 1. What we need from you

| Item | Why | Notes |
|---|---|---|
| Organisation name and postal address | Shown in every email footer, as POPIA and anti-spam rules require | |
| First administrator's name and email | They create the first sign-in | They can add colleagues afterwards |
| Web address | Where your team signs in, and the address in unsubscribe and tracking links | e.g. `mail.yourcompany.co.za`. Your IT team adds one DNS record (CNAME) we send them |
| Mail server (SMTP) details | MailHarbor sends through it | Host, port, username, password. We'll give you a secure way to send the password: **don't email it**. The service must allow marketing email (e.g. Amazon SES, Mailgun, SendGrid, Brevo, SMTP2GO, your own relay). A normal Microsoft 365 or Google Workspace mailbox isn't suitable for bulk sending |
| Sending domain | Lets inboxes trust your emails | Your IT team adds SPF, DKIM and DMARC records (see the [administrator guide §5](ADMIN_GUIDE.md#5-dns-and-deliverability)) |
| Replies mailbox | Replies to your campaigns arrive in the Inbox, where your team reads and answers them | A dedicated mailbox with IMAP, e.g. `replies@yourcompany.co.za`. You connect it in Settings → Replies |
| Bounce mailbox | Removes invalid addresses automatically | A dedicated mailbox with IMAP, e.g. `bounces@yourcompany.co.za`, or your provider's bounce notifications. You enter it yourself in Settings |

## 2. First sign-in

1. We send you your web address, and separately a one-time **setup code**.
2. Open the address, enter the code, and create your administrator account (password of at least 12 characters, with
   letters and a number). The code then stops working.
3. You'll also see an account marked **Managed by MailHarbor** under Users. It's our support and recovery account,
   used only to restore access or when you ask us for help. Everything it does is in your audit log.

## 3. Before your first campaign

Open **System health** in the app. Every item marked critical must be green:

- [ ] **Settings → General:** postal address
- [ ] **Settings → Email design:** your logo and brand colour
- [ ] **Settings → Sending:** From name and address (on your sending domain), then **Send test email**
- [ ] **Settings → Bounces:** bounce mailbox, then **Test connection**
- [ ] **Settings → Replies:** Reply-To address and replies mailbox, then **Test connection**
- [ ] DNS: SPF and DMARC green on System health; DKIM set up at your mail provider
- [ ] **Users:** add colleagues with the lowest role they need, and keep at least two administrators

## 4. Your first campaign

1. **Lists → New list**, then **Import** a CSV. Record how and when people gave permission: having an address isn't
   consent.
2. **Campaigns → New campaign**: choose the list, start from a sample design, build the email with drag and drop, and
   send a test to yourself.
3. Start on a small, engaged list. On a new domain, keep the sending speed low (2–5 emails per second) for the first
   few weeks.
4. Watch **Reports** for bounces and complaints, and answer replies in the **Inbox**.

## Help

- In the app: **Guides** in the menu.
- [User guide](USER_GUIDE.md): contacts, lists, campaigns, email design, reports.
- [Administrator guide](ADMIN_GUIDE.md): settings, users, DNS, bounces, monitoring.
- [Security & POPIA](SECURITY.md): how your data is protected.
- Anything else, including mail server changes or lost access: contact MailHarbor support.
