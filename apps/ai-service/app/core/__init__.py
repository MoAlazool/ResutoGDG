"""Pure model code (no web framework). Imported by the service and by research/ pipelines,
so the code that is evaluated offline is exactly the code that serves predictions."""
import os

# Per-series models are small (hundreds of rows): single-threaded OpenMP is faster and avoids
# thread oversubscription when several requests or research workers run in parallel.
os.environ.setdefault("OMP_NUM_THREADS", "1")
