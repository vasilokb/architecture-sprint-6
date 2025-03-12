## Описание задачи
Сервисы `core-app` и `ins-comp-settlement` получают данные о продуктах через REST API сервиса `ins-product-aggregator`, который синхронно запрашивает информацию у пяти страховых компаний, агрегирует её и возвращает в рамках одного запроса. `core-app` делает запрос каждые 15 минут, `ins-comp-settlement` — раз в сутки (ночью). Также `ins-comp-settlement` раз в сутки запрашивает у `core-app` данные об оформленных страховках через REST API. Планируется рост до 10 страховых компаний, что усугубит текущие проблемы. Требуется спроектировать решение для устранения задержек, ошибок и обеспечения масштабируемости.

### Цели:
1. Устранить синхронные зависимости и задержки.
2. Обеспечить актуальность данных и отказоустойчивость.
3. Подготовить архитектуру к росту нагрузки.

---

## Анализ текущей архитектуры

### Текущая схема контейнеров (C4)
```
@startuml
!include https://raw.githubusercontent.com/vasilokb/plantUML/refs/heads/main/C4.puml
Person(customer, "Клиент", "Взаимодействует с системой")
System(payment_services, "Платежные сервисы", "Обработка платежей")
Boundary(users, "Пользователи") {
    System(partner_system, "Система партнеров", "Взаимодействие с партнерами")
    System(insurance_system, "Системы страховых компаний (5)", "API для тарифов и продуктов")
}

Boundary(insuretech_pro, "InsureTech Pro") {
    Container(insuretech_web, "InsureTech Web", "Веб-приложение", , , , "Vue.js, React") #lightblue
    Container(core_app, "core-app", "Монолит: продукты, страховки", , , , "Kotlin, SpringBoot")
    Container(client_info, "client-info", "Учет клиентских данных", , , , "Kotlin, SpringBoot")
    Container(product_aggregator, "ins-product-aggregator", "Агрегация продуктов", , , , "Kotlin, SpringBoot")
    Container(settlement, "ins-comp-settlement", "Служба расчетов", , , , "Kotlin, SpringBoot")
    ContainerDb(core_db, "core-db", "Тарифы, заявки", , , , "PostgreSQL") #grey
    ContainerDb(client_info_db, "client-info-db", "Данные клиентов", , , , "PostgreSQL") #grey
    ContainerDb(settlement_db, "settlement-db", "Страховки, расчеты", , , , "PostgreSQL") #grey
}

Rel(customer, insuretech_web, "Взаимодействие", "REST")
Rel(insuretech_web, payment_services, "Оплата (redirect)", "HTTP")
Rel(insuretech_web, client_info, "Данные клиента", "REST")
Rel(insuretech_web, core_app, "Тарифы, заявки", "REST")
Rel(partner_system, core_app, "Оформление страховок", "REST")
Rel(core_app, payment_services, "Оплата", "HTTP")
Rel(core_app, client_info, "Клиенты", "REST")
Rel(core_app, product_aggregator, "Продукты (каждые 15 мин)", "REST")
Rel(settlement, product_aggregator, "Продукты (раз в сутки)", "REST")
Rel(settlement, core_app, "Страховки (раз в сутки)", "REST")
Rel(settlement, insurance_system, "Взаиморасчеты", "REST/SOAP/GraphQL")
Rel(client_info, client_info_db, "Данные клиентов", "TCP")
Rel(core_app, core_db, "Тарифы, заявки", "TCP")
Rel(settlement, settlement_db, "Расчеты", "TCP")
Rel(product_aggregator, insurance_system, "Запросы тарифов", "REST/SOAP/GraphQL")
@enduml
```

### Проблемы текущей архитектуры
1. **Задержки в ответах**: Синхронные запросы к 5 компаниям увеличивают время ответа `ins-product-aggregator`.
2. **Ошибки взаимодействия**: Сбой одного API ломает весь запрос.
3. **Высокая нагрузка**: 96 запросов в сутки от `core-app` + 1 от `ins-comp-settlement` создают нагрузку.
4. **Устаревшие данные**: Интервалы 15 минут и 24 часа приводят к неактуальности.
5. **Синхронный запрос страховок**: Ночной REST от `ins-comp-settlement` к `core-app` создаёт пиковую нагрузку и риски сбоев.

### Риски роста (до 10 компаний)
1. **Увеличение времени ответа**: Больше компаний = больше задержек.
2. **Рост вероятности ошибок**: Увеличивается шанс сбоев внешних API.
3. **Перегрузка**: Нагрузка на `ins-product-aggregator` и `core-app` вырастет.
4. **Несогласованность данных**: Устаревание станет критичнее.

---

## Предложенное решение

### Описание решения
1. **Для данных о продуктах**:
   - Планировщик в `ins-product-aggregator` опрашивает страховые компании каждые 15 минут, кэширует данные в `product-agg-db` и публикует события `ProductUpdated` в топик Kafka `product-updates` через Transactional Outbox.
   - `core-app` получает данные через REST (кэш) или Kafka (опционально).
   - `ins-comp-settlement` подписывается на `product-updates`, сохраняет данные в `settlement-db`.

2. **Для данных о страховках**:
   - `core-app` при оформлении страховки записывает событие `InsuranceIssued` в `core-db` через Transactional Outbox и публикует его в топик Kafka `insurance-events`.
   - `ins-comp-settlement` подписывается на `insurance-events`, накапливает страховки в `settlement-db` и формирует реестр ночью из локальных данных.

### Обоснования решений
1. **Планировщик каждые 15 минут**:
   - Сохраняет частоту обновления `core-app`, минимизирует устаревание.
   - Распределяет нагрузку на внешние API.
2. **Transactional Outbox для продуктов**:
   - Гарантирует атомарность, прост в `Kotlin, SpringBoot`, задержка 1-5 секунд допустима.
   - CDC избыточен для 15-минутного интервала.
3. **Kafka для продуктов**:
   - Убирает polling, масштабируется с ростом компаний.
4. **Transactional Outbox для страховок**:
   - Атомарность, простота, задержка не критична для суточного реестра.
   - CDC сложнее и избыточен.
5. **Kafka для страховок**:
   - Устраняет ночной REST, снижает нагрузку, повышает автономность.

---

## Обновлённые схемы

### Схема контейнеров (C4)
```
@startuml
!include https://raw.githubusercontent.com/vasilokb/plantUML/refs/heads/main/C4.puml
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
    Container(product_aggregator, "ins-product-aggregator", "Опрос каждые 15 мин, кэш, Outbox в Kafka", , , , "Kotlin, SpringBoot, Scheduler") #yellow
    Container(settlement, "ins-comp-settlement", "Расчеты: реестр из локальных данных (Kafka)", , , , "Kotlin, SpringBoot")
    Container(kafka, "Kafka", "Топики: product-updates, insurance-events", , , , "Apache Kafka") #yellow

    ContainerDb(core_db, "core-db", "Тарифы, заявки, outbox для страховок", , , , "PostgreSQL") #grey
    ContainerDb(client_info_db, "client-info-db", "Данные клиентов", , , , "PostgreSQL") #grey
    ContainerDb(settlement_db, "settlement-db", "Страховки (Kafka), продукты (Kafka), расчеты", , , , "PostgreSQL") #grey
    ContainerDb(product_agg_db, "product-agg-db", "Кэш продуктов, outbox (обновление каждые 15 мин)", , , , "PostgreSQL") #grey
}

Rel(customer, insuretech_web, "Взаимодействие", "REST")
Rel(insuretech_web, payment_services, "Оплата (redirect)", "HTTP")
Rel(insuretech_web, client_info, "Данные клиента", "REST")
Rel(insuretech_web, core_app, "Тарифы, заявки", "REST")
Rel(partner_system, core_app, "Оформление страховок", "REST")
Rel(core_app, payment_services, "Оплата", "HTTP")
Rel(core_app, client_info, "Клиенты", "REST")

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
@enduml
```

### Технологическая архитектура (to-be)
```
@startuml InsureTech_технологическая архитектура_to-be
skinparam monochrome true
skinparam linetype ortho

' Участники
[Браузер\nпользователя] #..# [CDN\n(Cloudflare)] : HTTP/HTTPS
[CDN\n(Cloudflare)] #..# [Глобальный\nбалансировщик\n(DNS GSLB)] : DNS-запросы

' Узлы и артефакты
node "Зона доступности 1 (Москва)" as AZ1 {
  node "Kubernetes Cluster 1" as K8sCluster1 {
    [LoadBalancer\n(Health Check)] #--# [InsureTech\nnamespace] : HTTP/HTTPS\n(Health Check: /health)
    [Kafka\n(3 брокера)] #--# [InsureTech\nnamespace] : Kafka\n(product-updates,\ninsurance-events)
  }
  node "VM 1" as VM1 {
    [PostgreSQL\n(master)] #--# [InsureTech\nnamespace] : TCP
  }
}

node "Зона доступности 2 (Новосибирск)" as AZ2 {
  node "Kubernetes Cluster 2" as K8sCluster2 {
    [LoadBalancer\n(Health Check)] #--# [InsureTech\nnamespace] : HTTP/HTTPS\n(Health Check: /health)
    [Kafka\n(2 брокера)] #--# [InsureTech\nnamespace] : Kafka\n(product-updates,\ninsurance-events)
  }
  node "VM 2" as VM2 {
    [PostgreSQL\n(replica)] #--# [InsureTech\nnamespace] : TCP
  }
}

' Связи между зонами
[Глобальный\nбалансировщик\n(DNS GSLB)] #--# [LoadBalancer\n(Health Check)] : Балансировка\n(Geo-based) : K8sCluster1
[Глобальный\nбалансировщик\n(DNS GSLB)] #--# [LoadBalancer\n(Health Check)] : Балансировка\n(Geo-based) : K8sCluster2
[PostgreSQL\n(master)] #--# [PostgreSQL\n(replica)] : Репликация\n(асинхронная,\nRPO=15 мин)
[Kafka\n(3 брокера)] #--# [Kafka\n(2 брокера)] : Репликация\n(синхронная,\nRPO=0)

' Комментарии
note right of K8sCluster1
  Kubernetes:
  - Изоляция сбоев
  - Гибкое масштабирование
  - Сервисы: core-app,\nproduct-aggregator,\nsettlement
end note

note right of [Kafka\n(3 брокера)]
  Kafka:
  - 5 брокеров (3+2)
  - Высокая доступность
  - Топики: product-updates,\ninsurance-events
end note

note right of [PostgreSQL\n(master)]
  БД:
  - Master-Replica (Patroni)
  - Outbox для событий
  - RPO=15 мин, RTO=45 мин
end note

note right of [Глобальный\nбалансировщик\n(DNS GSLB)]
  GSLB:
  - Geo-based routing
  - Фейловер (RTO=45 мин)
end note
@enduml
```

---

## Решение проблем и рисков

### Проблемы
1. **Задержки в ответах**:
   - **Продукты**: Планировщик и кэш устраняют синхронность, Kafka — polling.
   - **Страховки**: Kafka заменяет REST, данные накапливаются локально.
2. **Ошибки взаимодействия**:
   - **Продукты**: Планировщик изолирует сбои, Outbox гарантирует доставку.
   - **Страховки**: Kafka обеспечивает доставку при сбоях `core-app`.
3. **Высокая нагрузка**:
   - **Продукты**: Опрос раз в 15 минут распределяет нагрузку.
   - **Страховки**: Постепенная передача через Kafka вместо пикового запроса.
4. **Устаревшие данные**:
   - Максимум 15 минут (кэш), 0 секунд (Kafka).
5. **Синхронный запрос страховок**:
   - Убран, заменён потоковой передачей.

### Риски роста
1. **Увеличение времени ответа**:
   - Кэш и Kafka устраняют синхронные зависимости.
2. **Рост вероятности ошибок**:
   - Планировщик и Outbox изолируют сбои, Kafka добавляет надёжность.
3. **Перегрузка**:
   - Асинхронность и Kafka масштабируются с ростом.
4. **Несогласованность**:
   - Локальные кэши в `settlement-db` синхронизируются через Kafka.

---

## Итоговый результат
- **Продукты**: Планировщик обновляет кэш каждые 15 минут, Kafka (`product-updates`) доставляет данные в `core-app` и `ins-comp-settlement`.
- **Страховки**: `core-app` публикует `InsuranceIssued` в Kafka, `ins-comp-settlement` накапливает их в `settlement-db` и формирует реестр автономно.
- **Инфраструктура**: Kafka в Kubernetes (5 брокеров) обеспечивает высокую доступность, PostgreSQL с Outbox — надёжность.

### Преимущества
- Устранение задержек и сбоев.
- Актуальность данных (15 минут или реальное время).
- Масштабируемость для 10+ компаний.

