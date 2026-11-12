FROM nginx:alpine
RUN printf '%s\n' \
  'worker_processes auto;' \
  'pid /tmp/nginx.pid;' \
  'error_log /dev/stderr warn;' \
  'events { worker_connections 1024; }' \
  'http {' \
  '  include /etc/nginx/mime.types;' \
  '  default_type application/octet-stream;' \
  '  access_log /dev/stdout;' \
  '  client_body_temp_path /tmp/client_temp;' \
  '  proxy_temp_path /tmp/proxy_temp;' \
  '  fastcgi_temp_path /tmp/fastcgi_temp;' \
  '  uwsgi_temp_path /tmp/uwsgi_temp;' \
  '  scgi_temp_path /tmp/scgi_temp;' \
  '  server_tokens off;' \
  '  sendfile on;' \
  '  gzip on;' \
  '  gzip_vary on;' \
  '  gzip_types text/plain text/css text/javascript application/javascript application/json image/svg+xml;' \
  '  server {' \
  '    listen __PORT__ default_server;' \
  '    server_name _;' \
  '    root /usr/share/nginx/html;' \
  '    index index.html;' \
  '    location ~ /\. { return 404; }' \
  '    location / { try_files $uri $uri/index.html /index.html; }' \
  '  }' \
  '}' \
  > /etc/nginx/keelson.conf.tpl && rm -rf /usr/share/nginx/html/*
ENV PORT=3000
COPY --chown=nginx:nginx ["public","/usr/share/nginx/html"]
USER nginx
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 CMD wget -qO- http://127.0.0.1:$PORT${HEALTH_PATH:-/} >/dev/null || exit 1
STOPSIGNAL SIGQUIT
CMD ["sh","-c","case \"$PORT\" in ''|*[!0-9]*) echo \"keelson: PORT must be a number\" >&2; exit 1;; esac; sed \"s/__PORT__/$PORT/\" /etc/nginx/keelson.conf.tpl > /tmp/nginx.conf && exec nginx -c /tmp/nginx.conf -g 'daemon off;'"]
