/* Swagger UI bootstrap. Mutating requests automatically get a CSRF token (the API uses a double-submit cookie). */
window.addEventListener('load', function () {
  var csrf = null;
  window.ui = SwaggerUIBundle({
    url: '/api/v1/openapi.json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    persistAuthorization: true,
    tryItOutEnabled: true,
    requestInterceptor: function (request) {
      request.credentials = 'same-origin';
      if (request.method === 'GET' || request.method === 'HEAD') return request;
      return fetch('/api/v1/csrf-token', { credentials: 'same-origin', cache: 'no-store' })
        .then(function (response) { return response.json(); })
        .then(function (body) {
          csrf = body.token;
          request.headers['X-CSRF-Token'] = csrf;
          return request;
        });
    },

  });
});
