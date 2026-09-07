# stepwise-eisu (for AI agents)

Read **docs/SYSTEM.md** first: it describes where every piece of this system lives (GitHub Pages for HTML, Google Apps Script for the API, two Google Spreadsheets in Drive for all data), the sheet schemas, API actions, and the deploy procedure. Keep that file updated when the structure changes.

Open issues and future work live in **docs/FUTURE_WORK.md**: whenever you notice something to fix later or a design gap, append it there during the task (move it to the "済み" section when done).

Rules: test only with students whose name starts with 【テスト】; never modify real students' data; never handle the teacher's password; `gas/Code.gs` is a copy of the Apps Script project and must be pasted and deployed as a new version to take effect.
