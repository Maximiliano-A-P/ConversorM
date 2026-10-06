import sys
import os
import base64
import webview


def ruta_recurso(relativa):
    """Resuelve la ruta a index.html/css/js tanto en modo desarrollo como
    ya empaquetado con PyInstaller (--onedir)."""
    base = getattr(sys, "_MEIPASS", os.path.abspath("."))
    return os.path.join(base, relativa)


class Api:
    """Se expone a JS como window.pywebview.api. La ventana embebida no
    tiene gestor de descargas propio, así que el guardado de archivos
    se hace acá, en Python, con un diálogo nativo.

    IMPORTANTE: los atributos que empiezan con "_" NO se exponen a JS.
    Si la ventana se guardara en un atributo público, pywebview intentaría
    introspeccionarla y podría bloquear la interfaz."""

    def __init__(self):
        self._ventana = None

    def guardar_archivo(self, nombre_sugerido, datos_base64):
        try:
            ruta = self._ventana.create_file_dialog(
                webview.SAVE_DIALOG, save_filename=nombre_sugerido
            )
            if isinstance(ruta, (list, tuple)):
                ruta = ruta[0] if ruta else None
            if not ruta:
                return {"ok": False, "motivo": "cancelado"}
            with open(ruta, "wb") as f:
                f.write(base64.b64decode(datos_base64))
            return {"ok": True, "ruta": ruta}
        except Exception as e:
            return {"ok": False, "motivo": str(e)}


if __name__ == "__main__":
    api = Api()
    ventana = webview.create_window(
        "ConversorM",
        ruta_recurso("index.html"),
        width=900,
        height=850,
        min_size=(600, 600),
        js_api=api,
    )
    api._ventana = ventana
    webview.start(gui="edgechromium", http_server=True)