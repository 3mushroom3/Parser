import asyncio
from playwright.async_api import async_playwright
import os
import subprocess
import time

async def main():
    # Start server
    proc = subprocess.Popen(["node", "server.js"], cwd="backend", env={**os.environ, "PORT": "3001", "DB_PATH": "../data/test.db"})
    time.sleep(3) # Wait for start

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()

        # 1. Login
        await page.goto("http://localhost:3001")
        await page.fill("#loginUser", "admin")
        await page.fill("#loginPass", "admin")
        await page.click("#loginBtn")

        await page.wait_for_selector("#app", state="visible")
        print("Logged in successfully")

        # 2. Check Dashboard/Registry
        await page.wait_for_selector("#tblBody")
        await page.screenshot(path="final_dashboard.png")
        print("Dashboard verified")

        await browser.close()

    proc.terminate()

if __name__ == "__main__":
    asyncio.run(main())
