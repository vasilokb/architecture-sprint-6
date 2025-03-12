## Описание задачи
Компания InsureTech планирует запустить оформление ОСАГО онлайн. Пользовательский путь:
1. Клиент заполняет заявку с данными об автомобиле.
2. Сервис запрашивает предложения от 10 страховых компаний.
3. Предложения отображаются в интерфейсе по мере поступления (максимальное время ожидания — 60 секунд).
4. Пиковая нагрузка: 2500 одновременных пользователей (25,000 запросов к страховым компаниям).

Страховые компании предоставляют REST API с двумя эндпоинтами:
- `POST /osago-request`: Создание заявки на ОСАГО.
- `GET /osago-offer/{requestId}`: Получение предложения.

### Решения команды
1. Сохранить подход из Задания 3: Kafka, Transactional Outbox для асинхронной обработки.
2. Выделить `osago-aggregator` для взаимодействия со страховыми компаниями.
3. Использовать REST для отправки заявок от `insuretech_web` к `core-app` и WebSocket для получения предложений.

### Цели
1. Обеспечить мгновенное отображение предложений.
2. Уложиться в 60-секундный таймаут.
3. Поддержать пиковую нагрузку (2500 пользователей).

---

## Анализ требований

### Пользовательский путь
1. Клиент через `insuretech_web` отправляет заявку на ОСАГО (REST).
2. `core-app` передаёт заявку в `osago-aggregator` (REST).
3. `osago-aggregator` запрашивает предложения у 10 страховых компаний (REST).
4. Предложения возвращаются через Kafka (`osago-offers`) в `core-app`.
5. `core-app` отправляет предложения клиенту через WebSocket по мере поступления.
6. Клиент выбирает предложение через WebSocket.

### Проблемы и риски
1. **Синхронные задержки**: Ожидание ответа от 10 компаний может превысить 60 секунд.
2. **Пиковая нагрузка**: 25,000 запросов к страховым API.
3. **Ошибки взаимодействия**: Сбой одной компании не должен блокировать процесс.
4. **Актуальность**: Предложения должны отображаться мгновенно.

---

## Окончательное решение

### Архитектура
1. **Инициирование заявки**:
   - `insuretech_web` отправляет заявку через REST (`POST /osago/request`) к `core-app` с паттерном `<<Rate Limiting>>`.
2. **Передача заявки**:
   - `core-app` отправляет заявку в `osago-aggregator` через REST с `<<Rate Limiting>>`.
3. **Обработка заявки**:
   - `osago-aggregator` запрашивает предложения у 10 страховых компаний через REST с паттернами `<<Circuit Breaker>>`, `<<Retry>>`, `<<Timeout>>` (60 секунд).
   - Сохраняет данные в `osago-agg-db` (PostgreSQL) с использованием Transactional Outbox.
4. **Передача предложений**:
   - `osago-aggregator` публикует предложения в Kafka (`osago-offers`).
   - `core-app` подписывается на `osago-offers`.
5. **Отображение предложений**:
   - `core-app` отправляет предложения клиенту через WebSocket (`ws://core-app/osago`) с паттернами `<<Rate Limiting>>` и `<<Timeout>>` (65 секунд).
   - Клиент выбирает предложение через WebSocket.

### Пример взаимодействия
**Сценарий**: Клиент оформляет ОСАГО:
- Клиент через `insuretech_web` отправляет заявку через REST:
  ```json
  {
    "carData": {
      "make": "Toyota",
      "model": "Camry",
      "year": 2020,
      "vin": "X123456789"
    }
  }
  ```
- `core-app` отвечает:
  ```json
  {
    "requestId": "uuid-123",
    "status": "processing"
  }
  ```
- Клиент открывает WebSocket-соединение (`ws://core-app/osago`) и отправляет:
  ```json
  {
    "action": "subscribeOffers",
    "requestId": "uuid-123"
  }
  ```
- `core-app` отправляет предложения по мере поступления:
  ```json
  {
    "action": "offerReceived",
    "requestId": "uuid-123",
    "offer": {"company": "CompanyA", "price": 15000}
  }
  ```
  ```json
  {
    "action": "offerReceived",
    "requestId": "uuid-123",
    "offer": {"company": "CompanyB", "price": 14500}
  }
  ```
- После завершения:
  ```json
  {
    "action": "requestCompleted",
    "requestId": "uuid-123",
    "status": "completed",
    "offersCount": 10
  }
  ```
- Клиент выбирает предложение:
  ```json
  {
    "action": "selectOffer",
    "requestId": "uuid-123",
    "company": "CompanyA"
  }
  ```
- `core-app` подтверждает:
  ```json
  {
    "action": "offerSelected",
    "requestId": "uuid-123",
    "status": "confirmed",
    "company": "CompanyA"
  }
  ```

### Обновлённая схема контейнеров (C4)
![### Обновлённая схема контейнеров (C4)](https://www.plantuml.com/plantuml/png/fLZTJXj75BxtKqoTIh5L_uGqYLIKHW6teYX4k9WabsYy7kmDwrrhTfOKDPKIqgILQ9KehLGfQadJle11k341p2lClb7F6Qyzzh1US0iNU6TdplVDTtxEmRTzGRa8caxg8zkrdA36I4E8bZzRB7Bwg52tHIEe1ZxZbkSAveg2vJMBczIt7M-ZMcmvr1NtxYuLELltYmr6QtwnIMstMBfMQ2cZDRPkkupCFQYKuVa2jkaZtw5L7__cRNZXvzSzdbT0OA2uEVDPuKgnPlj24uwC5-5loMisFJV2Dj_VfIwjioOWBNYRZBlKjLYHEav_--MIumMr1rHOZJc7yYPPeOAH9Rjf2yRF6gi8ZzFwwFbvQcq4hViqSCIIPssGaisjm1PadZEw0IOka_wE5MOX_DQgtMJBrOVC4lOc8-ef4B1B_Y7RuTDmEtmYU_9GVf1j4hwG-x8JRiF2Ff47yYXyISAdyXIsTEL9VptbRzXkYtBQ93umPfxOQh4IGjQv5xYrakTud5nQu8ov5zfxywPMm7RhjsvDTzYuFXvVORMB8ZF1j_38l1Em2vv11Rr0uAbbJjqwIwNAZFkUcx42NtXDndCaBT_88z2iWwgbyVcrV2_Ri78C6Xx0-Y5AB_V3PwWtY8mwTzLQH-qvJ6TJbItWqSoqw1O6qnf4yAPjCH_DlGNpRRNv7u3OaHqytm4_xIihEmfpL-x1IblkoHviHGVBqv5p7GKoZrUZV2k36HBPxe7dVmB2uEveDrmcdINVfWZy36bnuJA-vgj7FFXEtq1XmTady7YYY86j925W1UzWdch3Fa0UnRLTF-2OK_78uGw9eheTFaVKS2TyJk3sFJ05nkK9G1sIpCoLBFAPAoyE8tqReS7Iz_tuxn8L-K0JlFIX7_r0vRkKrannOO9PZRKMzy3SebfOXGLIvjvGiX9K7cg3MgCd7h7g-8a7h1f9r95x-IZjZW0MVALeT-1r_pTzFs25X-2k5KOj0JYN7BlU45K8OmFGyZXRewqMdC6FUVYeG7u7koVeQRZmzgnnrN0dPwW80dPp12f7rVk6W3ftwFe6rNJkUCAntHofj3ZayBpd0IUJY6DZ5DlkEWhLVyhZawBpT_Y3oWJ06IOEX3IWelSEbDzEq9LJOO9JQe4brcYzpbcT2Wzp4roGZrxazOieOvGC48UOBg3xWSgjcUi4ur2Uv60z_3dySIebuBFLOBN0OHm9ZZFqcH2EQXOHCsXEhRnULRJ-L9LQ2HJkp1AWs87FoZy4QBqdAag0iSfRaCdGZ6GKoUnKsctW4TYgZYeQVm78AU21KsR9GC6WLQC2Yz8mB_Di4uZx6cokHK60lb00CuxpHRKVehNg849hrGWjoaOCHYmQuSj167fA_2XlpK058JHqsVC5UBZozHBc27pQEekkup8YeKDpmENNWPQoCnQX23WLc7Pi7qi_3w3UcLatS5xkJ8xgDtX2HyXKZ4PIf4zf93K6dDvWpCTKmw4dCl2q9qyKvQD1iPgGGzbpwLrUhimjB9zXwlcqxccUwd6KvMywH0XayZlvIluYToFPEl9Wj9I6BmVS9x0XbpYhZLFG17GjwPFGIyb4Uhgyc9oYhdJZYchayWCuLJcNV89jeGA37XF9wTjdZErfXJaZiuZPSH9RCF9V-RAociugA-RPk55aTpXKj4a6ADYSMKBrrgzMLyiJ38qaNM9-jSyXfBjRGi5uJCOcpA79tCS-w2VOv-P87iayep2DGMSSSnU71K0zrc4VKu-CIsW3v-YfHJJE6VBfOHEoVmX6iYeKOfjWt13r2aTGiF4SOpHono46RN9F7E0LAyjpvU82fwq6Pj14QBFWHEL5TXKi39o3wj6DcYm2h9RA2IO7hKg-XTgqfyG0gk4Bp7DIxX-uf_fKBJtiQAQcCOOJIX_9JAvkyRxM95NQdUB8YZO8tBTji5G5zHGle3mHzNNPoqwchvjeJ0injJHF9okuE0YMHTyFpageUzZKbuoNy3y3c4m1OLzDIrf1UKpalbewxYTi8fhHhXF2GNPZybwhRHesyyyeoqO_JyYmiKfWZZB9Wujc5pNSk0ghGuIaPmh4BBAndGuCJwYi-aNIbnJHTMV7opPvJA9_lTDZzJccBHkJ0l3ggQe6MWogjEOEVifDwiVdvatCI72rG10Gx1_eMXOl5FcVdSb4ZushJmjaV2BfdZ-861pnMv98VjJZCIa5Or-w44sS33riV4-LI5pdzRK2YQr1otXYUNsTSGWPPc-Ebg6S8OkoDHQvrmjJ6HWUDSSDC7K32ExYk7JstzLdf4ZaQyYrFSnWOv01fMLlD13QydWyPzB3GO_an-D2Ip-IMkHCRk7lrMpgDdDhGTFv5m00)

```
@startuml
!include https://raw.githubusercontent.com/vasilokb/plantUML/refs/heads/main/C4.puml
!define AWSPuml https://raw.githubusercontent.com/awslabs/aws-icons-for-plantuml/v19.0/dist
!include AWSPuml/AWSCommon.puml
!include AWSPuml/ManagementGovernance/all.puml
'CloudWatchAlarm Rate Limiter
!include AWSPuml/Storage/all.puml
'BackupVaultLock Circuit Breaker
' BackupRecoveryTimeObjective TimeOut
' Настройка цветов для спринтов
skinparam stereotypeCBackgroundColor #Green
skinparam stereotypeCBackgroundColor<<Rate Limiting>> #Green
skinparam stereotypeCBackgroundColor<<Circuit Breaker>> #Red
skinparam stereotypeCBackgroundColor<<Retry>> #Blue
skinparam stereotypeCBackgroundColor<<Timeout>> #Orange

Person(customer, "Клиент", "Взаимодействует с системой")
System(payment_services, "Платежные сервисы", "Обработка платежей")
Boundary(users, "Пользователи") {
    System(partner_system, "Система партнеров", "Взаимодействие с партнерами")
    System(insurance_system, "Системы страховых компаний (10)", "API для тарифов и продуктов")
}

Boundary(insuretech_pro, "InsureTech Pro") {
    Container(insuretech_web, "InsureTech Web", "Веб-приложение", , , , "Vue.js, React") #lightblue
    Container(core_app, "core-app", "Монолит: продукты, страховки, Outbox в Kafka", , , , "Kotlin, SpringBoot")
    Container(client_info, "client-info", "Учет клиентских данных", , , , "Kotlin, SpringBoot")
    Container(product_aggregator, "ins-product-aggregator", "Опрос каждые 15 мин, кэш, Outbox в Kafka", , , , "Kotlin, SpringBoot, Scheduler")
     Container(settlement, "ins-comp-settlement", "Расчеты: реестр из локальных данных (Kafka)", , , , "Kotlin, SpringBoot")
    Container(kafka, "Kafka", "Топики: product-updates, insurance-events", , , , "Apache Kafka")

    ContainerDb(core_db, "core-db", "Тарифы, заявки, outbox для страховок", , , , "PostgreSQL") #grey
    ContainerDb(client_info_db, "client-info-db", "Данные клиентов", , , , "PostgreSQL") #grey
    ContainerDb(settlement_db, "settlement-db", "Страховки (Kafka), продукты (Kafka), расчеты", , , , "PostgreSQL") #grey
    ContainerDb(product_agg_db, "product-agg-db", "Кэш продуктов, outbox (обновление каждые 15 мин)", , , , "PostgreSQL") #grey
    'OSAGO
    ContainerDb(osago_agg_db, "osago-agg-db", "Заявки ОСАГО, предложения, outbox", , , , "PostgreSQL")  #red
    Container(osago_aggregator, "osago-aggregator", "Заявки ОСАГО, опрос предложений (60 сек), Kafka + WebSocket", , , , "Kotlin, SpringBoot") #red

}

Rel(customer, insuretech_web, "Взаимодействие", "REST")
Rel(insuretech_web, payment_services, "Оплата (redirect)", "HTTP")
Rel(insuretech_web, client_info, "Данные клиента", "REST")
Rel(insuretech_web, core_app, "Тарифы, заявки| Rate Limiting", "REST",$sprite=CloudWatchAlarm  , , , 1)
Rel(partner_system, core_app, "Оформление страховок", "REST")
Rel(core_app, payment_services, "Оплата", "HTTP")
Rel(core_app, client_info, "Клиенты", "REST" )

Rel(product_aggregator, insurance_system, "Асинхронный опрос каждые 15 мин", "REST/SOAP/GraphQL")
Rel(product_aggregator, product_agg_db, "Кэширование и Outbox", "TCP")
Rel(product_aggregator, kafka, "Публикация ProductUpdated", "Kafka")
Rel(core_app, product_aggregator, "Кэш продуктов (каждые 15 мин)", "REST")
Rel(core_app, kafka, "Подписка на ProductUpdated (опционально)", "Kafka")
Rel(core_app, core_db, "Страховки и Outbox", "TCP")
Rel(core_app, kafka, "Публикация InsuranceIssued", "Kafka")
Rel(settlement, kafka, "Подписка на ProductUpdated (каждые 15 мин)", "Kafka")
Rel(settlement, kafka, "Подписка на InsuranceIssued (в реальном времени)", "Kafka")
Rel(settlement, settlement_db, "Кэш продуктов и страховок", "TCP")
Rel(settlement, insurance_system, "Взаиморасчеты", "REST/SOAP/GraphQL")
Rel(client_info, client_info_db, "Данные клиентов", "TCP")
'OSAGO

Rel(insuretech_web,core_app,  "1. Тарифы, заявки ОСАГО", $sprite=CloudWatchAlarm, $sprite= BackupRecoveryTimeObjective, "REST: Rate Limiting | Timeout" , , , 1)
Rel(osago_aggregator, osago_agg_db, "Сохранение заявок, предложений и Outbox", "TCP")
Rel(core_app, osago_aggregator, "2. Создание заявки ОСАГО | Rate Limiting", "REST",$sprite=CloudWatchAlarm  , , , 1)
Rel(osago_aggregator, insurance_system, "3. Заявки и опрос предложений ОСАГО | Retry | Time Out| Curcuit Breaker ", "REST",  $sprite=BackupVaultLock, , , 1)
Rel(osago_aggregator, kafka, "4. Публикация OsagoOfferReceived", "Kafka",  , , , 1)
Rel(kafka,core_app,  "5. OsagoOfferReceived", "Kafka",  , , , 1)
Rel(core_app,insuretech_web,   "6. Ответ клиенту / Выбор клиента по заявкам ОСАГО", "WebSocket - Rate Limiting| Time Out", $sprite= CloudWatchAlarm, , , 2)

@enduml
```

##### Обоснования решений по дополненной архитектуре для ОСАГО
1. **Использование REST для отправки заявок**:
   - **Почему**: REST (`POST /osago/request`) обеспечивает надёжную и предсказуемую инициацию заявки с возвратом `requestId`. Это снижает нагрузку на WebSocket, который иначе пришлось бы открывать сразу для всех 2500 пользователей, что может привести к перегрузке сервера. Паттерн `<<Rate Limiting>>` (ограничение до 3000 запросов) защищает `core-app` от пиковой нагрузки.
   - **Как**: Клиент отправляет данные автомобиля, `core-app` создаёт заявку и возвращает `requestId`, что позволяет клиенту управлять следующим шагом (WebSocket).

2. **Использование WebSocket для получения предложений и выбора**:
   - **Почему**: WebSocket (`ws://core-app/osago`) обеспечивает мгновенное отображение предложений по мере их поступления от `osago-aggregator` через Kafka. Двунаправленность позволяет клиенту выбирать предложение, что критично для пользовательского опыта. Паттерны `<<Rate Limiting>>` (3000 соединений) и `<<Timeout>>` (65 секунд) управляют нагрузкой и предотвращают зависания соединений, обеспечивая устойчивость при 2500 пользователях с масштабированием через Kubernetes.
   - **Как**: После получения `requestId` клиент подключается к WebSocket, подписывается на поток предложений и отправляет выбор.

3. **Выделение `osago-aggregator` с собственной базой данных `osago-agg-db`**:
   - **Почему**: `osago-aggregator` выделен для изоляции логики взаимодействия со страховыми компаниями, что улучшает масштабируемость и отказоустойчивость. Собственная база данных (`osago-agg-db`) на PostgreSQL обеспечивает персистентность заявок, предложений и Transactional Outbox, гарантируя доставку событий в Kafka даже при сбоях. Это соответствует подходу из Задания 3 и поддерживает обработку 25,000 запросов.
   - **Как**: Заявки сохраняются в `osago-agg-db`, предложения агрегируются и публикуются в Kafka через Outbox.

4. **Использование Kafka для асинхронной передачи данных**:
   - **Почему**: Kafka (`osago-requests` для заявок, `osago-offers` для предложений) обеспечивает масштабируемую и надёжную асинхронную передачу данных между `core-app` и `osago-aggregator`. Это позволяет обрабатывать пиковую нагрузку (25,000 запросов) и обеспечивает мгновенность отображения предложений через WebSocket. Transactional Outbox в `osago-aggregator` гарантирует консистентность.
   - **Как**: `core-app` публикует заявку в `osago-requests`, `osago-aggregator` подписывается, обрабатывает и публикует предложения в `osago-offers`.

5. **Паттерн Rate Limiting (<<Rate Limiting>>)**:
   - **Почему**: Применён на REST-отношениях (`insuretech_web` → `core_app`, `core_app` → `osago_aggregator`) для ограничения до 3000 запросов/соединений, что защищает систему от перегрузки при 2500 пользователях. Это особенно важно для REST-запросов, которые инициируют процесс.
   - **Как**: Реализовано через CloudWatchAlarm или аналогичный механизм на уровне LoadBalancer.

6. **Паттерн Circuit Breaker (<<Circuit Breaker>>)**:
   - **Почему**: Использован на `osago_aggregator` → `insurance_system` для изоляции сбоев одной компании (например, таймаут или 500 ошибка), что предотвращает блокирование всего процесса. Это критично при работе с 10 компаниями.
   - **Как**: Реализовано через библиотеку (например, Resilience4j) с состоянием "открыт/закрыт".

7. **Паттерн Retry (<<Retry>>)**:
   - **Почему**: Применён на `osago_aggregator` → `insurance_system` для преодоления временных сбоев (например, 3 попытки с экспоненциальной задержкой: 100мс, 200мс, 400мс), что укладывается в 60-секундный лимит.
   - **Как**: Встроено в HTTP-клиент `osago-aggregator`.

8. **Паттерн Timeout (<<Timeout>>)**:
   - **Почему**: Установлен на `osago_aggregator` → `insurance_system` (60 секунд) для соответствия требованиям и на WebSocket (`insuretech_web` → `core_app`, 65 секунд) для предотвращения зависаний соединений. Это гарантирует, что процесс не превысит лимит ожидания.
   - **Как**: Настроено на уровне HTTP-клиента и WebSocket-сервера.

##### Оценка выполнения
- **Положительное**:
   - REST для заявок упрощает инициирование, снижая нагрузку на WebSocket.
   - WebSocket для предложений обеспечивает мгновенность.
   - Kafka для асинхронности соответствует заданию.
   - Паттерны отказоустойчивости (Rate Limiting, Circuit Breaker, Retry, Timeout) учтены.
- **Рекомендации**:
   - Усилить масштабирование WebSocket через Kubernetes HPA.
   - Добавить мониторинг для WebSocket-соединений.

##### Итоговый результат
- **Интеграция `insuretech_web` и `core-app`**:
   - REST [<<Rate Limiting>>] для заявок.
   - WebSocket [<<Rate Limiting>>] [<<Timeout>>] для предложений и выбора.
- **Интеграция `core-app` и `osago-aggregator`**:
   - Kafka (`osago-requests` → `osago-offers`).
   - REST [<<Rate Limiting>>] (fallback).
- **Интеграция `osago-aggregator` и страховых компаний**:
   - REST [<<Circuit Breaker>>], [<<Retry>>], [<<Timeout>>].
- **Инфраструктура**: Kafka, WebSocket, PostgreSQL и паттерны отказоустойчивости обеспечивают надёжность, масштабируемость и мгновенное отображение предложений.
