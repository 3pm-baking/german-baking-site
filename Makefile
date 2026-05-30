build:
	PREVIEW=$(PREVIEW) uv run build.py
	uv run scripts/sync_also_available.py
	uv run scripts/sync_locations.py

serve-preview:
	$(MAKE) build PREVIEW=true
	uv run python -m http.server 8080 & sleep 1 && open http://localhost:8080

serve:
	$(MAKE) build
	uv run python -m http.server 8080 & sleep 1 && open http://localhost:8080

stop:
	@PID=$$(lsof -ti :8080); \
	if [ -n "$$PID" ]; then \
		kill $$PID && echo "Server stopped."; \
	else \
		echo "No server running on port 8080."; \
	fi
