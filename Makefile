build: 
	uv run build.py
	uv run sync_also_available.py
	uv run sync_locations.py
