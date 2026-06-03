"""
Утилита для съёма JSON-ответов браузера (Playwright) при открытии страницы декларации.
Рабочая интеграция с API ФГИС вынесена в Node.js:
  - services/apiClient.js — сессия, POST /login, запросы к API
  - services/parser.js — нормализация полей
  - services/declarationService.js — getDeclarationData(id), пакеты с p-limit
  - HTTP: GET /api/fsa/declarations/:id/data, POST /api/fsa/declarations/data-batch
Переменные окружения: см. config/fsaConfig.js (FSA_BASE_URL, FSA_ANON_USERNAME, …).
"""
import asyncio
import json
import sys
from playwright.async_api import async_playwright

async def capture_requests(url):
    """Захватывает все сетевые запросы при загрузке веб-страницы и выводит JSON ответы."""
    async with async_playwright() as p:
        # Запуск браузера
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        
        # Список для хранения запросов и ответов
        requests = []
        responses = []
        
        # Включаем перехват запросов
        await page.route("**/*", lambda route, request: requests.append({
            'url': request.url,
            'method': request.method,
            'headers': dict(request.headers),
            'resource_type': request.resource_type
        }) or route.continue_())
        
        # Включаем перехват ответов
        async def handle_response(response):
            try:
                # Проверяем, является ли ответ JSON
                content_type = response.headers.get('content-type', '')
                if 'application/json' in content_type or 'json' in content_type:
                    try:
                        json_data = await response.json()
                        responses.append({
                            'url': response.url,
                            'status': response.status,
                            'json': json_data
                        })
                    except:
                        # Если не удалось распарсить как JSON, сохраняем текст
                        text = await response.text()
                        responses.append({
                            'url': response.url,
                            'status': response.status,
                            'text': text[:200] + '...' if len(text) > 200 else text
                        })
            except Exception as e:
                pass  # Игнорируем ошибки при обработке ответов
        
        page.on("response", handle_response)
        
        # Переходим по URL
        print(f"Загрузка {url}...")
        await page.goto(url, wait_until="networkidle")
        
        # Ждем немного дольше для любых поздних запросов
        await asyncio.sleep(10)
        
        # Закрываем браузер
        await browser.close()
        
        # Выводим захваченные запросы
        print(f"\nЗахвачено {len(requests)} запросов:")
        for i, req in enumerate(requests, 1):
            print(f"{i}. {req['method']} {req['url']} [{req['resource_type']}]")
        
        # Выводим JSON ответы
        print(f"\nПолучено {len(responses)} JSON ответов:")
        for i, resp in enumerate(responses, 1):
            print(f"\n{i}. URL: {resp['url']}")
            print(f"   Статус: {resp['status']}")
            if 'json' in resp:
                print("   JSON ответ:")
                print(json.dumps(resp['json'], indent=4, ensure_ascii=False))
            elif 'text' in resp:
                print("   Текстовый ответ (первые 200 символов):")
                print(resp['text'])
        
        return requests, responses

def main():
    # URL по умолчанию - можно переопределить через командную строку
    default_url = "https://pub.fsa.gov.ru/rds/declaration/view/21297092/common"
    
    if len(sys.argv) < 2:
        url = default_url
        print(f"Используется URL по умолчанию: {url}")
        print("Для указания своего URL: python scrape.py <URL>")
    else:
        url = sys.argv[1]
    
    asyncio.run(capture_requests(url))

if __name__ == "__main__":
    main()