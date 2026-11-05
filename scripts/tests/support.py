"""What the build tests share: the build script loaded as a module (its main() runs only under
__main__), and the newest partial store and fixture database, which SKKG_TEST_STORE and
SKKG_FIXTURE_DB override."""
import importlib.util
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("build_db", ROOT / "scripts" / "build_db.py")
b = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(b)


def newest(pattern):
    found = sorted(ROOT.glob(pattern))
    return found[-1] if found else None


STORE = Path(os.environ["SKKG_TEST_STORE"]) if os.environ.get("SKKG_TEST_STORE") else newest("data/oxigraph/partial-*")
DB = Path(os.environ["SKKG_FIXTURE_DB"]) if os.environ.get("SKKG_FIXTURE_DB") else newest("data/db/skkg-partial-*.sqlite")
