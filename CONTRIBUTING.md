# Contributing to SOFC Plant Utility Monitor

Thank you for your interest in contributing to the SOFC Plant Utility Monitor project! We welcome contributions, bug reports, feature requests, and improvements.

---

## Code of Conduct

Please maintain a professional, respectful, and collaborative tone in all discussions and pull requests.

---

## Development Setup

### 1. Prerequisites
- **Python 3.10+** (Python 3.11 recommended)
- **Node.js 18+** & **npm** (for frontend development)
- *(Optional)* **MongoDB** (Local instance or MongoDB Atlas cluster for persistence)

### 2. Backend Setup
```bash
cd backend
python -m venv .venv

# On Linux/macOS:
source .venv/bin/activate
# On Windows (PowerShell):
.\.venv\Scripts\Activate.ps1

pip install -r requirements.txt
cp .env.example .env

# Run FastAPI server
uvicorn app.main:app --reload --port 8000
```

### 3. Frontend Setup
```bash
cd frontend
npm install
cp .env.example .env

# Run Vite development server
npm run dev
```

---

## Running Tests

Before submitting a Pull Request, ensure that all automated tests pass:

### Backend Tests
```bash
cd backend
pytest -v
```

### Frontend Tests & Typecheck
```bash
cd frontend
npm run typecheck
npm test
npm run build
```

---

## Pull Request Guidelines

1. **Fork & Branch**: Create a feature branch with a descriptive name:
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/issue-description
   ```
2. **Atomic Commits**: Keep commit messages clear, concise, and written in the imperative mood (e.g. `feat: add Aspen reconciliation tolerance calculation`).
3. **No Committed Secrets**: Never commit `.env` files, API keys, or production credentials.
4. **Pass CI**: Ensure both Python and TypeScript CI checks pass cleanly.
5. **Open PR**: Push your branch to GitHub and open a Pull Request against `main`.
