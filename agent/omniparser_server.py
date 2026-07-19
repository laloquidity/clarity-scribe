"""OmniParser HTTP sidecar - Scribe's screen "eyes" for agent mode.

Loads the OmniParser v2 models (YOLO icon detector + Florence-2 captioner)
once and serves screen parses over loopback HTTP so the Electron main process
can ask "what is on screen?" in ~2s instead of paying a ~15s model load per
question. Stdlib-only on purpose: the OmniParser venv has torch/PIL but no
web framework, and one lock-guarded worker matches the GPU anyway.

  GET  /health          -> {"ready": bool}         (503 until models loaded)
  POST /parse           -> {"elements": [...], "width": W, "height": H, "ms": N}
       body: {"image_b64": "<png>"}

Elements are [{id, type, content, interactive, bbox}] with bbox as ratio
[x1,y1,x2,y2] of the submitted image - the caller owns pixel conversion.

Env: SCRIBE_OMNIPARSER_DIR (repo with weights/, util/), SCRIBE_OMNIPARSER_PORT.
Run with the OmniParser venv python and PYTHONUTF8=1 (easyocr's progress bar
crashes on cp1252 consoles otherwise).
"""
import base64
import io
import json
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

OMNI_DIR = Path(os.environ.get('SCRIBE_OMNIPARSER_DIR', r'C:\Users\Hilal\tools\OmniParser'))
PORT = int(os.environ.get('SCRIBE_OMNIPARSER_PORT', '8093'))
sys.path.insert(0, str(OMNI_DIR))

_ready = threading.Event()
_gpu_lock = threading.Lock()
_models = {}


def load_models():
    t0 = time.time()
    import torch  # noqa: F401  (must import before util.utils on some setups)
    from util.utils import get_yolo_model, get_caption_model_processor
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    _models['yolo'] = get_yolo_model(model_path=str(OMNI_DIR / 'weights' / 'icon_detect' / 'model.pt'))
    _models['caption'] = get_caption_model_processor(
        model_name='florence2',
        model_name_or_path=str(OMNI_DIR / 'weights' / 'icon_caption_florence'),
        device=device)
    _ready.set()
    print(f'[omniparser-server] models ready on {device} in {time.time() - t0:.1f}s', flush=True)


def parse_png(png_bytes):
    from PIL import Image
    from util.utils import get_som_labeled_img, check_ocr_box
    image = Image.open(io.BytesIO(png_bytes)).convert('RGB')
    (text, ocr_bbox), _ = check_ocr_box(
        image, display_img=False, output_bb_format='xyxy', goal_filtering=None,
        easyocr_args={'paragraph': False, 'text_threshold': 0.8}, use_paddleocr=False)
    _, _, parsed = get_som_labeled_img(
        image, _models['yolo'], BOX_TRESHOLD=0.05, output_coord_in_ratio=True,
        ocr_bbox=ocr_bbox, draw_bbox_config=None,
        caption_model_processor=_models['caption'], ocr_text=text,
        use_local_semantics=True, iou_threshold=0.7, scale_img=False, batch_size=128)
    elements = []
    for i, el in enumerate(parsed):
        elements.append({
            'id': i,
            'type': el.get('type', ''),
            'content': (el.get('content') or '').strip(),
            'interactive': bool(el.get('interactivity', False)),
            'bbox': [round(float(v), 4) for v in el.get('bbox', [0, 0, 0, 0])],
        })
    return elements, image.size


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            self._json(200 if _ready.is_set() else 503, {'ready': _ready.is_set()})
        else:
            self._json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/parse':
            return self._json(404, {'error': 'not found'})
        if not _ready.is_set():
            return self._json(503, {'error': 'models still loading'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            payload = json.loads(self.rfile.read(length))
            png = base64.b64decode(payload['image_b64'])
            t0 = time.time()
            with _gpu_lock:
                elements, (w, h) = parse_png(png)
            self._json(200, {'elements': elements, 'width': w, 'height': h,
                             'ms': int((time.time() - t0) * 1000)})
        except Exception as e:
            traceback.print_exc()
            self._json(500, {'error': str(e)})

    def log_message(self, fmt, *args):  # keep stdout clean for the sidecar log
        pass


if __name__ == '__main__':
    threading.Thread(target=load_models, daemon=True).start()
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'[omniparser-server] listening on 127.0.0.1:{PORT}', flush=True)
    server.serve_forever()
