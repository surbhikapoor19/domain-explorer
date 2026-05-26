---
title: Grasp Planner Explorer
emoji: 🤖
colorFrom: purple
colorTo: blue
sdk: docker
app_port: 7860
app_file: app.py
pinned: false
---

# Grasp Planner UMAP Visualization

Interactive UMAP visualization of grasp planners with weighted column embeddings.

## Setup

### Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python app.py
```

Backend runs on http://localhost:5000

### Frontend

```bash
cd frontend
npm install
npm start
```

Frontend runs on http://localhost:3000

## Features

- Weighted UMAP projection based on column importance
- Interactive scatter plot with Plotly
- Click points to see full description and metadata
- Configurable weights in backend/app.py

## Column Weights

Edit `COLUMN_WEIGHTS` in `backend/app.py`:
- Planning Method: 10
- Object Configuration: 10  
- Output Pose: 10
- Training Data: 8
- And more...

## Files

- `backend/app.py` - Flask API with UMAP computation
- `frontend/src/App.js` - React visualization
- `csv-gp-combined.csv` - Data with all columns + combined description
