let contextInvalidated = false;

function checkContext() {
  if (contextInvalidated) return false;
  try {
    void chrome.runtime.id;
    return true;
  } catch (_) {
    contextInvalidated = true;
    return false;
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;

  if (event.data?.type === 'GCHAT_MANAGER_XSRF' && event.data.token) {
    if (!checkContext()) return;
    chrome.runtime.sendMessage({
      type: 'PRIVATE_XSRF_TOKEN',
      token: event.data.token,
    }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!checkContext()) return;

  if (request.type === 'PRIVATE_API_REQUEST') {
    const requestId = 'private_api_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    let responded = false;

    const respond = (data) => {
      if (responded) return;
      responded = true;
      window.removeEventListener('message', handler);
      sendResponse(data);
    };

    const handler = (event) => {
      if (event.source !== window) return;
      if (event.data?.type !== 'GCHAT_MANAGER_API_RESPONSE') return;
      if (event.data.requestId !== requestId) return;

      respond({
        ok: event.data.ok,
        status: event.data.status,
        body: event.data.body,
        error: event.data.error,
      });
    };

    window.addEventListener('message', handler);

    setTimeout(() => {
      respond({ ok: false, status: 0, error: 'Request timed out' });
    }, 30000);

    window.postMessage({
      type: 'GCHAT_MANAGER_API_REQUEST',
      requestId,
      url: request.url,
      method: request.method || 'POST',
      headers: request.headers || {},
      body: request.body,
    }, '*');

    return true;
  }

  if (request.type === 'PRIVATE_GET_XSRF') {
    let responded = false;

    const respond = (data) => {
      if (responded) return;
      responded = true;
      window.removeEventListener('message', handler);
      sendResponse(data);
    };

    const handler = (event) => {
      if (event.source !== window) return;
      if (event.data?.type !== 'GCHAT_MANAGER_XSRF') return;
      respond({ token: event.data.token });
    };

    window.addEventListener('message', handler);
    setTimeout(() => {
      respond({ token: null });
    }, 2000);

    window.postMessage({ type: 'GCHAT_MANAGER_GET_XSRF' }, '*');
    return true;
  }
});
