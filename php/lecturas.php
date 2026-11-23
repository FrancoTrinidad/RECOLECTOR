<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

function responder(int $codigo, array $datos): void
{
    http_response_code($codigo);
    echo json_encode($datos, JSON_UNESCAPED_UNICODE);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    responder(405, ['error' => 'Usa POST para enviar una lectura.']);
}

try {
    $datos = json_decode(file_get_contents('php://input'), true, 16, JSON_THROW_ON_ERROR);
} catch (JsonException) {
    responder(400, ['error' => 'JSON inválido.']);
}

$id = $datos['id'] ?? null;
$nivel = $datos['level'] ?? null;

if (!in_array($id, ['C-01', 'C-05'], true)
    || !is_int($nivel) || $nivel < 0 || $nivel > 100) {
    responder(422, ['error' => 'Usa C-01 o C-05 y un nivel entero de 0 a 100.']);
}

try {
    $dsn = 'pgsql:host=127.0.0.1;port=5432;dbname=recolector';
    $db = new PDO($dsn, getenv('ECORUTA_DB_USER') ?: 'postgres', getenv('ECORUTA_DB_PASSWORD') ?: '', [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    ]);

    $consulta = $db->prepare(
        "INSERT INTO readings (container_id, level, source)
         SELECT id, :nivel, 'esp32'
         FROM containers
         WHERE id = :id
         RETURNING id"
    );
    $consulta->execute(['nivel' => $nivel, 'id' => $id]);

    if ($consulta->fetchColumn() === false) {
        responder(404, ['error' => 'El contenedor no está registrado en PostgreSQL.']);
    }

    responder(201, ['ok' => true, 'id' => $id, 'level' => $nivel]);
} catch (PDOException $error) {
    error_log($error->getMessage());
    responder(503, ['error' => 'Revisa el error de PostgreSQL en la terminal de PHP.']);
}