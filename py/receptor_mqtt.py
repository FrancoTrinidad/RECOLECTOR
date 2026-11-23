import json
from getpass import getpass
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import paho.mqtt.client as mqtt

HOST = "fa3e701f.ala.us-east-1.emqxsl.com"
USUARIO = "Ruta-Prueba"
PUERTO = 8883
CERTIFICADO = Path(__file__).with_name("emqxsl-ca.crt")
TOPICO = "ecoruta/+/llenado"
URL_PHP = "http://127.0.0.1:8000/php/lecturas.php"


def al_conectar(cliente, datos, flags, motivo, propiedades):
    if motivo.is_failure:
        print(f"EMQX rechazó la conexión: {motivo}", flush=True)
        return
    cliente.subscribe(TOPICO)


def al_suscribir(cliente, datos, mensaje_id, motivos, propiedades):
    if motivos and motivos[0].is_failure:
        print(f"EMQX rechazó la suscripción: {motivos[0]}", flush=True)
        return
    print(f"Escuchando {TOPICO}", flush=True)


def al_recibir(cliente, datos, mensaje):
    try:
        lectura = json.loads(mensaje.payload)
    except (ValueError, UnicodeError):
        print("Se ignoró un mensaje con JSON inválido.", flush=True)
        return

    if not isinstance(lectura, dict):
        return

    contenedor = lectura.get("id")
    nivel = lectura.get("level")
    if (
        contenedor not in ("C-01", "C-05")
        or mensaje.topic != f"ecoruta/{contenedor}/llenado"
        or type(nivel) is not int
        or not 0 <= nivel <= 100
    ):
        print(f"Lectura inválida en {mensaje.topic}", flush=True)
        return

    solicitud = Request(
        URL_PHP,
        data=json.dumps({"id": contenedor, "level": nivel}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urlopen(solicitud, timeout=5) as respuesta:
            if respuesta.status == 201:
                print(f"Guardado: {contenedor} al {nivel} %", flush=True)
            else:
                print(f"Respuesta inesperada de PHP: HTTP {respuesta.status}", flush=True)
    except HTTPError as error:
        detalle = error.read().decode("utf-8", errors="replace")
        print(f"PHP respondió HTTP {error.code}: {detalle}", flush=True)
    except (URLError, TimeoutError) as error:
        print(f"No se pudo contactar a PHP: {error}", flush=True)


cliente = mqtt.Client(
    mqtt.CallbackAPIVersion.VERSION2,
    protocol=mqtt.MQTTv5,
)
cliente.username_pw_set(USUARIO, getpass("Contraseña MQTT: "))
cliente.tls_set(ca_certs=str(CERTIFICADO))
cliente.on_connect = al_conectar
cliente.on_subscribe = al_suscribir
cliente.on_message = al_recibir
cliente.connect(HOST, PUERTO, keepalive=60)
cliente.loop_forever()