import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
EDGE = Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")


@unittest.skipUnless(EDGE.exists(), "Microsoft Edge is required for the userscript browser test")
class UserscriptStorageTests(unittest.TestCase):
    def test_old_full_games_are_migrated_without_losing_complete_record(self):
        old_game = {
            "black": "100001",
            "white": "100002",
            "winner": "black",
            "moves": 1,
            "history": [{"ply": 1, "row": 7, "col": 7, "color": "black", "uid": "100001"}],
            "executions": [{
                "at": "2026-09-04T00:00:01.000Z",
                "uid": "100001",
                "color": 0,
                "input": "0\n" + "0 " * 225,
                "response": {"success": True, "output": "7 7"},
            }],
            "reason": "网页 Game Over：Player #0 (100001) won.",
            "pageMessage": "Game Over",
            "pageMessages": ["Game Over"],
            "finishedAt": "2026-09-04T00:00:02.000Z",
        }
        fixture = {
            "id": "group-A-test",
            "phase": "group",
            "group": "A",
            "round": "小组 A",
            "players": ["100001", "100002"],
            "games": [old_game],
            "status": "running",
        }
        state = {
            "format": "beta-gomoku-page-record-2.0",
            "createdAt": "2026-09-04T00:00:00.000Z",
            "seed": "storage-test",
            "roster": [],
            "ties": {},
            "groups": [],
            "groupFixtures": [fixture],
            "knockout": None,
            "events": [{
                "type": "game_finished",
                "at": old_game["finishedAt"],
                "fixture": fixture["id"],
                "game": 1,
                "result": old_game,
            }],
            "waiting": None,
            "archives": {"group": False, "final": False},
            "settings": {"autoDownload": False, "autoNext": False},
        }

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=str(EDGE), headless=True)
            page = browser.new_page()
            page.route("http://gomoku.test/", lambda route: route.fulfill(
                content_type="text/html",
                body=(
                    "<!doctype html><html><head></head><body>"
                    "<select id='player0'><option value='100001'>100001</option></select>"
                    "<select id='player1'><option value='100002'>100002</option></select>"
                    "<div id='fastmode'><input type='checkbox'></div>"
                    "<button id='start_button'>Start</button>"
                    "<script>window.draw_chess = function () {};</script>"
                    "</body></html>"
                ),
            ))
            page.goto("http://gomoku.test/")
            page.evaluate("state => localStorage.setItem('ruc-betagomoku-real-start-v2', JSON.stringify(state))", state)
            page.add_script_tag(path=str(ROOT / "beta-gomoku-tournament.user.js"))
            page.wait_for_function("""
                () => {
                  const state = JSON.parse(localStorage.getItem('ruc-betagomoku-real-start-v2'));
                  return state.events.some(event => event.type === 'large_state_migrated_to_indexeddb');
                }
            """)

            migrated = page.evaluate("JSON.parse(localStorage.getItem('ruc-betagomoku-real-start-v2'))")
            summary = migrated["groupFixtures"][0]["games"][0]
            self.assertNotIn("input", summary["executions"][0])
            self.assertTrue(summary["archiveKey"])
            self.assertNotIn("history", migrated["events"][0]["result"])

            archived = page.evaluate("""
                async key => {
                  const request = indexedDB.open('ruc-betagomoku-full-games-v1', 1);
                  const db = await new Promise((resolve, reject) => {
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                  });
                  const get = db.transaction('games', 'readonly').objectStore('games').get(key);
                  return await new Promise((resolve, reject) => {
                    get.onsuccess = () => resolve(get.result.record);
                    get.onerror = () => reject(get.error);
                  });
                }
            """, summary["archiveKey"])
            self.assertEqual(archived["game"]["executions"][0]["input"], old_game["executions"][0]["input"])
            self.assertEqual(archived["game"]["history"], old_game["history"])
            self.assertIn("v2.5.0", page.locator("#bgta-launch").inner_text())
            browser.close()


if __name__ == "__main__":
    unittest.main()
