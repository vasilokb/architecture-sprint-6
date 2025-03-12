# Инструкция по выполнению Задания 2: Настройка динамического масштабирования в Kubernetes

## Описание задачи
Задание 2 требует настройки динамического масштабирования приложения `scaletestapp` (образ `shestera/scaletestapp`) в Kubernetes с использованием Horizontal Pod Autoscaler (HPA). Базовая часть включает развёртывание приложения и настройку инфраструктуры, а дополнительное задание — масштабирование по количеству запросов в секунду (RPS) с использованием метрик `http_requests_total` (из Prometheus) и `http_requests_per_second` (в HPA с `target: type: AverageValue`).

### Цели:
1. Развернуть приложение и подготовить инфраструктуру.
2. Настроить масштабирование по RPS (10 запросов в секунду на под) с Prometheus и Prometheus Adapter.
3. Провести тестирование с Locust.

---

## Предварительные требования
- Установлен Minikube: `minikube start --driver=docker --memory=4096 --cpus=2`.
- Установлен kubectl: версия v1.32.0.
- Установлен Helm: версия v3.15.0 (добавлен в `PATH`: `C:\Users\Lenovo\bin`).
- Установлен Python с Locust: `pip install locust`.
- Директория проекта: `D:\Practicum\sprint-6\insuretech`.

---

## Часть 1: Развёртывание приложения и базовая настройка

### Шаг 1: Запуск Minikube
```cmd
minikube start --driver=docker --memory=4096 --cpus=2
```
- Убедитесь, что кластер работает:
  ```cmd
  kubectl get nodes
  ```

### Шаг 2: Развёртывание приложения
1. **Deployment** (`deployment.yaml`):
   ```yaml
   apiVersion: apps/v1
   kind: Deployment
   metadata:
     name: scaletestapp
   spec:
     replicas: 1
     selector:
       matchLabels:
         app: scaletestapp
     template:
       metadata:
         labels:
           app: scaletestapp
       spec:
         containers:
         - name: scaletestapp
           image: shestera/scaletestapp
           ports:
           - containerPort: 8080
   ```
   ```cmd
   kubectl apply -f D:\Practicum\sprint-6\insuretech\manifests\deployment.yaml
   ```

2. **Service** (`service.yaml`):
   ```yaml
   apiVersion: v1
   kind: Service
   metadata:
     name: scaletestapp-service
   spec:
     selector:
       app: scaletestapp
     ports:
     - protocol: TCP
       port: 80
       targetPort: 8080
     type: LoadBalancer
   ```
   ```cmd
   kubectl apply -f D:\Practicum\sprint-6\insuretech\manifests\service.yaml
   ```

3. Проверьте:
   ```cmd
   kubectl get pods
   minikube service scaletestapp-service --url
   ```
    - Вывод: `http://127.0.0.1:61160`.

---

## Часть 2: Масштабирование по RPS с Prometheus

### Шаг 1: Установка Prometheus Operator
1. Репозиторий:
   ```cmd
   helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
   helm repo update
   ```
2. Установка:
   ```cmd
   helm install prometheus-operator prometheus-community/kube-prometheus-stack --namespace monitoring --create-namespace --set prometheus.service.type=ClusterIP
   ```
3. Проверка:
   ```cmd
   kubectl get pods -n monitoring
   ```

### Шаг 2: Экспорт метрик в Prometheus
1. Обновите `service.yaml` для Prometheus:
   ```yaml
   apiVersion: v1
   kind: Service
   metadata:
     name: scaletestapp-service
     labels:
       prometheus-monitored: "true"
   spec:
     selector:
       app: scaletestapp
     ports:
     - protocol: TCP
       port: 80
       targetPort: 8080
     type: LoadBalancer
   ```
   ```cmd
   kubectl apply -f D:\Practicum\sprint-6\insuretech\manifests\service.yaml
   ```

2. **ServiceMonitor** (`servicemonitor.yaml`):
   ```yaml
   apiVersion: monitoring.coreos.com/v1
   kind: ServiceMonitor
   metadata:
     name: scaletestapp-app-sm
     namespace: default
     labels:
       release: prometheus-operator
   spec:
     endpoints:
     - interval: 10s
       targetPort: 8080
       path: /metrics
     namespaceSelector:
       matchNames:
       - default
     selector:
       matchLabels:
         prometheus-monitored: "true"
   ```
   ```cmd
   kubectl apply -f D:\Practicum\sprint-6\insuretech\manifests\servicemonitor.yaml
   ```

3. Проверьте метрику `http_requests_total`:
   ```cmd
   kubectl port-forward -n monitoring svc/prometheus-operated 9090:9090
   ```
    - В `http://localhost:9090`: выполните `http_requests_total`.
    - Пример вывода:
      ```
      http_requests_total{method="GET",pod="scaletestapp-xxxxx-yyyyy"} 123
      ```

### Шаг 3: Установка Prometheus Adapter
1. Репозиторий:
   ```cmd
   helm repo add prometheus-adapter https://prometheus-community.github.io/helm-charts
   helm repo update
   ```
2. Установка:
   ```cmd
   helm install prometheus-adapter prometheus-adapter/prometheus-adapter --namespace monitoring --set prometheus.url=http://prometheus-operated.monitoring.svc.cluster.local --set prometheus.port=9090 --set logLevel=4
   ```
3. Проверка:
   ```cmd
   kubectl get pods -n monitoring | findstr prometheus-adapter
   ```

### Шаг 4: Настройка ConfigMap для RPS
1. **ConfigMap** (`adapter-config.yaml`):
   ```yaml
   apiVersion: v1
   kind: ConfigMap
   metadata:
     name: adapter-config
     namespace: monitoring
   data:
     config.yaml: |
       rules:
       - seriesQuery: 'http_requests_total{namespace="default",pod=~"scaletestapp-.*"}'
         resources:
           overrides:
             namespace: {resource: "namespace"}
             pod: {resource: "pod"}
         name:
           matches: "^(.*)_total"
           as: "http_requests_per_second"
         metricsQuery: 'sum(rate(<<.Series>>{<<.LabelMatchers>>}[1m])) by (<<.GroupBy>>)'
   ```
   ```cmd
   kubectl apply -f D:\Practicum\sprint-6\insuretech\manifests\adapter-config.yaml
   ```
2. Перезапуск Adapter:
   ```cmd
   kubectl delete pod -n monitoring -l app.kubernetes.io/name=prometheus-adapter
   ```

3. Проверьте метрику `http_requests_per_second`:
   ```cmd
   kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1" > metrics.txt
   notepad metrics.txt
   ```
    - Найдите `http_requests_per_second`.

### Шаг 5: Настройка HPA по RPS
1. **HPA** (`hpa.yaml`):
   ```yaml
   apiVersion: autoscaling/v2
   kind: HorizontalPodAutoscaler
   metadata:
     name: scaletestapp-hpa
   spec:
     scaleTargetRef:
       apiVersion: apps/v1
       kind: Deployment
       name: scaletestapp
     minReplicas: 1
     maxReplicas: 10
     metrics:
     - type: Pods
       pods:
         metric:
           name: http_requests_per_second
         target:
           type: AverageValue
           averageValue: 10
   ```
   ```cmd
   kubectl apply -f D:\Practicum\sprint-6\insuretech\manifests\hpa.yaml
   ```

2. Проверка:
   ```cmd
   kubectl get hpa
   ```
    - Пример вывода:
      ```
      NAME               REFERENCE                 TARGETS    MINPODS   MAXPODS   REPLICAS
      scaletestapp-hpa   Deployment/scaletestapp   5/10       1         10        1
      ```

### Шаг 6: Тестирование масштабирования по RPS
1. **Locust** (`locustfile.py`):
   ```python
   from locust import HttpUser, between, task

   class WebsiteUser(HttpUser):
       wait_time = between(1, 5)

       @task
       def index(self):
           self.client.get("/")
   ```
   ```cmd
   cd D:\Practicum\sprint-6\insuretech\locust
   locust --host http://127.0.0.1:61160
   ```
    - В `http://localhost:8089`: 100 пользователей, 10 spawn rate.
2. Следите:
   ```cmd
   kubectl get hpa -w
   ```
    - Результат: При RPS >10 (например, 15) реплики увеличились до 2+.

---

## Архитектура
```
+-------------------+       +-------------------+       +-------------------+
|   Locust (Load)   | ----> | Service (LoadB)   | ----> | Deployment (Pods) |
+-------------------+       +-------------------+       +-------------------+
                                    |                           |
                                    v                           v
                            +-------------------+       +-------------------+
                            |   Prometheus      | <---- |   ServiceMonitor  |
                            +-------------------+       +-------------------+
                                    |
                                    v
                            +-------------------+
                            | Prometheus Adapter|
                            +-------------------+
                                    |
                                    v
                            +-------------------+
                            |       HPA         |
                            +-------------------+
                                    |
                                    v
                            +-------------------+
                            |  Kubernetes API   |
                            +-------------------+
```

- **Locust**: Генерирует HTTP-запросы.
- **Service**: Распределяет трафик.
- **Deployment**: Управляет подами.
- **ServiceMonitor**: Экспорт `http_requests_total` в Prometheus.
- **Prometheus**: Сбор `http_requests_total`.
- **Prometheus Adapter**: Преобразование в `http_requests_per_second`.
- **HPA**: Масштабирование по RPS (`AverageValue: 10`).

---

## Результаты
- **http_requests_total**: Собирается Prometheus из `/metrics` приложения.
- **http_requests_per_second**: Преобразуется Adapter и используется HPA.
- Масштабирование: Реплики увеличиваются при RPS >10 (например, с 1 до 2 при 15 RPS).

---

## Возможные проблемы и решения
- **Порт 9090 занят**: `netstat -aon | findstr :9090`, `taskkill /PID <PID> /F`.
- **Adapter не видит метрики**: Увеличьте `logLevel=4`, проверьте логи:
  ```cmd
  kubectl logs -n monitoring -l app.kubernetes.io/name=prometheus-adapter
  ```
- **HPA `<unknown>`**: Переустановите:
  ```cmd
  kubectl delete hpa scaletestapp-hpa
  kubectl apply -f hpa.yaml
  ```