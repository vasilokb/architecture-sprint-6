http {
   # Определение зоны для Rate Limiting
   limit_req_zone $binary_remote_addr zone=partner_limit:10m rate=10r/m;

   # Настройка upstream для балансировки нагрузки
   upstream backend_servers {
       server backend1.example.com;
       server backend2.example.com;
       server backend3.example.com;
   }

   server {
       listen 80;

       location / {
           # Применение Rate Limiting
           limit_req zone=partner_limit burst=5 nodelay;
           limit_req_status 429; # Код ошибки 429 Too Many Requests

           # Добавление заголовка Retry-After при превышении лимита
           limit_req_log_level warn;
           error_page 429 @ratelimit;
           proxy_pass http://backend_servers;
       }

       # Кастомный ответ для ошибки 429
       location @ratelimit {
           add_header Retry-After 6; # Ожидать 6 секунд перед повторным запросом
           return 429 "Too Many Requests - Please try again after 6 seconds\n";
       }
   }
}