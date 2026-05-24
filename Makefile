build: 
	uv run build.py
	uv run sync_also_available.py
	uv run sync_locations.py

serve:
	uv run python -m http.server 8080 & sleep 1 && open http://localhost:8080
