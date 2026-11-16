'use strict';

/**
 * Thin client for the listmonk REST API (tested against listmonk v6.2.0).
 * All writes to subscribers and lists go through here so that listmonk's own
 * validation and business rules always apply.
 *
 * Auth: listmonk API users authenticate with `Authorization: token user:token`.
 */
const { upstream, AppError } = require('./errors');

class ListmonkClient {
  constructor({ baseUrl, apiUser, apiToken, timeoutMs = 15000, logger }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.setCredentials(apiUser, apiToken);
    this.timeoutMs = timeoutMs;
    this.log = logger;
  }

  /** Credentials can arrive after startup (self-bootstrap on Railway). */
  setCredentials(apiUser, apiToken) {
    this.auth = apiUser && apiToken ? `token ${apiUser}:${apiToken}` : null;
  }

  get ready() {
    return Boolean(this.auth);
  }

  async request(method, path, { query, body, form, timeoutMs } = {}) {
    if (!this.auth && path !== '/api/health') {
      throw upstream('The connection to listmonk is still being set up. Try again in a minute.');
    }
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue;
        if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
        else url.searchParams.set(k, String(v));
      }
    }
    const headers = { Accept: 'application/json' };
    if (this.auth) headers.Authorization = this.auth;
    let payload;
    if (form) {
      payload = form;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs || this.timeoutMs),
      });
    } catch (err) {
      const reason = err.name === 'TimeoutError' ? 'timed out' : 'is unreachable';
      throw upstream(`listmonk ${reason}`, { path, cause: err.message });
    }

    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { message: text.slice(0, 200) };
    }
    if (!res.ok) {
      const msg = json?.message || `listmonk returned HTTP ${res.status}`;
      this.log?.warn({ path, status: res.status, msg }, 'listmonk API error');
      // Surface listmonk's validation messages to the operator; mask server errors.
      if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403) {
        throw new AppError(res.status === 404 ? 404 : 422, 'LISTMONK_REJECTED', msg);
      }
      if (res.status === 401 || res.status === 403) {
        throw upstream('listmonk rejected the portal API credentials or permissions', { status: res.status, msg });
      }
      throw upstream(msg, { status: res.status });
    }
    return json.data;
  }

  // ---- System -------------------------------------------------------------
  health() { return this.request('GET', '/api/health', { timeoutMs: 5000 }); }
  config() { return this.request('GET', '/api/config'); }
  settings() { return this.request('GET', '/api/settings'); }
  logs() { return this.request('GET', '/api/logs'); }

  // ---- Lists --------------------------------------------------------------
  getLists() { return this.request('GET', '/api/lists', { query: { per_page: 'all', minimal: true } }); }
  createList(body) { return this.request('POST', '/api/lists', { body }); }
  updateList(id, body) { return this.request('PUT', `/api/lists/${Number(id)}`, { body }); }
  deleteList(id) { return this.request('DELETE', `/api/lists/${Number(id)}`); }

  // ---- Subscribers --------------------------------------------------------
  getSubscriber(id) { return this.request('GET', `/api/subscribers/${Number(id)}`); }
  createSubscriber(body) { return this.request('POST', '/api/subscribers', { body }); }
  /** Partial update; omitting `lists` leaves subscriptions untouched. */
  patchSubscriber(id, body) { return this.request('PATCH', `/api/subscribers/${Number(id)}`, { body }); }
  deleteSubscriber(id) { return this.request('DELETE', `/api/subscribers/${Number(id)}`); }
  blocklistSubscribers(ids) {
    return this.request('PUT', '/api/subscribers/blocklist', { body: { ids: ids.map(Number) } });
  }
  /** action: add | remove | unsubscribe. */
  manageLists({ ids, action, listIds, status }) {
    return this.request('PUT', '/api/subscribers/lists', {
      body: { ids: ids.map(Number), action, target_list_ids: listIds.map(Number), status },
    });
  }
  exportSubscriberData(id) { return this.request('GET', `/api/subscribers/${Number(id)}/export`); }

  // ---- Bulk import --------------------------------------------------------
  importStatus() { return this.request('GET', '/api/import/subscribers'); }
  importLogs() { return this.request('GET', '/api/import/subscribers/logs'); }
  /**
   * Starts listmonk's asynchronous bulk importer.
   * csv: string with header email,name,attributes.
   */
  startImport({ csv, listIds, subscriptionStatus }) {
    const form = new FormData();
    form.append(
      'params',
      JSON.stringify({
        mode: 'subscribe',
        subscription_status: subscriptionStatus,
        delim: ',',
        lists: listIds.map(Number),
        // Never overwrite existing records: the portal only sends new addresses,
        // and this is a second line of defence against reactivation.
        overwrite: false,
        overwrite_userinfo: false,
        overwrite_subscription_status: false,
      }),
    );
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'import.csv');
    return this.request('POST', '/api/import/subscribers', { form, timeoutMs: 60000 });
  }

  // ---- Bounces ------------------------------------------------------------
  /** Records a bounce via listmonk's bounce webhook (requires webhooks enabled). */
  recordBounce({ email, subscriberUuid, campaignUuid, type, source, meta }) {
    return this.request('POST', '/webhooks/bounce', {
      body: {
        email,
        subscriber_uuid: subscriberUuid,
        campaign_uuid: campaignUuid,
        type,
        source: source || 'api',
        meta: meta || {},
      },
    });
  }
}

module.exports = { ListmonkClient };
