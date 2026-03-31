(function () {
  if (window.__gchatManagerPageLoaded) return;
  window.__gchatManagerPageLoaded = true;

  let capturedXsrf = null;

  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._gchatUrl = typeof url === 'string' ? url : url?.toString() || '';
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (name.toLowerCase() === 'x-framework-xsrf-token' && value) {
      if (capturedXsrf !== value) {
        capturedXsrf = value;
        window.postMessage({ type: 'GCHAT_MANAGER_XSRF', token: value }, '*');
      }
    }
    return origSetHeader.call(this, name, value);
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const headers = init?.headers;
      if (headers) {
        let token = null;
        if (headers instanceof Headers) {
          token = headers.get('x-framework-xsrf-token');
        } else if (typeof headers === 'object') {
          for (const [k, v] of Object.entries(headers)) {
            if (k.toLowerCase() === 'x-framework-xsrf-token') {
              token = v;
              break;
            }
          }
        }
        if (token && capturedXsrf !== token) {
          capturedXsrf = token;
          window.postMessage({ type: 'GCHAT_MANAGER_XSRF', token }, '*');
        }
      }
    } catch (_) {}

    return origFetch.apply(this, arguments);
  };

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== 'GCHAT_MANAGER_API_REQUEST') return;

    const { requestId, url, method, headers, body } = event.data;

    try {
      const response = await origFetch(url, {
        method: method || 'POST',
        credentials: 'include',
        headers: headers || {},
        body: body || undefined,
      });

      const text = await response.text();
      window.postMessage({
        type: 'GCHAT_MANAGER_API_RESPONSE',
        requestId,
        ok: response.ok,
        status: response.status,
        body: text,
      }, '*');
    } catch (err) {
      window.postMessage({
        type: 'GCHAT_MANAGER_API_RESPONSE',
        requestId,
        ok: false,
        status: 0,
        error: err.message,
      }, '*');
    }
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== 'GCHAT_MANAGER_GET_XSRF') return;

    window.postMessage({
      type: 'GCHAT_MANAGER_XSRF',
      token: capturedXsrf,
    }, '*');
  });
})();
