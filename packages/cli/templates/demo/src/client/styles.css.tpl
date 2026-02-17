:root {
  font-family: 'SF Pro Text', 'Segoe UI', Helvetica, Arial, sans-serif;
  color: #0f172a;
  background: linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
}

.page {
  max-width: 760px;
  margin: 0 auto;
  padding: 48px 20px;
}

header h1 {
  margin: 0;
  font-size: 2rem;
}

header p {
  margin: 6px 0 0;
  color: #334155;
}

.card {
  margin-top: 24px;
  padding: 20px;
  border-radius: 14px;
  background: #ffffff;
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08);
}

.input-row {
  display: flex;
  gap: 10px;
}

.input-row input {
  flex: 1;
  padding: 10px 12px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
}

button {
  padding: 10px 14px;
  border: 0;
  border-radius: 8px;
  background: #2563eb;
  color: #ffffff;
  cursor: pointer;
}

button:disabled {
  opacity: 0.7;
  cursor: default;
}

.task-list {
  margin: 16px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.task-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
}

.task-list label {
  display: flex;
  align-items: center;
  gap: 10px;
}

.error {
  margin: 12px 0;
  color: #dc2626;
}
