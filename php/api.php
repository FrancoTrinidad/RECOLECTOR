<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function respond(int $status, mixed $payload): never
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'] ?? '';
if ($method !== 'GET' && $method !== 'POST') {
    header('Allow: GET, POST');
    respond(405, ['error' => 'Método no permitido.']);
}

try {
    $dsn = getenv('ECORUTA_DSN') ?: 'pgsql:host=127.0.0.1;port=5432;dbname=recolector';
    $db = new PDO($dsn, getenv('ECORUTA_DB_USER') ?: 'postgres', getenv('ECORUTA_DB_PASSWORD') ?: '', [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    ]);

    if ($method === 'GET') {
        $sql = <<<'SQL'
        SELECT b.id, b.name, b.unit, b.latitud, b.longitud, latest.level, latest.recorded_at AS "recordedAt"
        FROM containers b
        LEFT JOIN LATERAL (
            SELECT level, recorded_at FROM readings
            WHERE container_id = b.id ORDER BY id DESC LIMIT 1
        ) latest ON TRUE
        ORDER BY b.id
        SQL;
        $rows = $db->query($sql)->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as &$row) {
            foreach (['unit', 'level'] as $field) {
                $row[$field] = $row[$field] === null ? null : (int) $row[$field];
            }
            foreach (['latitud', 'longitud'] as $field) {
                $row[$field] = $row[$field] === null ? null : (float) $row[$field];
            }
        }
        unset($row);
        $base = $db->query('SELECT latitud, longitud FROM route_base WHERE id = 1')->fetch(PDO::FETCH_ASSOC);
        respond(200, [
            'bins' => $rows,
            'base' => $base ? array_map(static fn ($value): float => (float) $value, $base) : null,
        ]);
    }

    if (!preg_match('~^application/json(?:\s*;|$)~i', $_SERVER['CONTENT_TYPE'] ?? '')) {
        respond(415, ['error' => 'Envía contenido JSON.']);
    }
    $input = json_decode(file_get_contents('php://input', false, null, 0, 4097), true, 16, JSON_THROW_ON_ERROR);
    $id = $input['id'] ?? null;
    $unit = $input['unit'] ?? null;
    $collect = ($input['collect'] ?? null) === true;
    $assign = is_int($unit) && $unit >= 1 && $unit <= 3;
    if (!is_string($id) || !preg_match('/^C-[0-9]{2}$/D', $id) || $collect === $assign) {
        respond(422, ['error' => 'Indica un contenedor y una acción válida.']);
    }

    if ($collect) {
        $statement = $db->prepare("INSERT INTO readings (container_id, level, source)
            SELECT id, 0, 'recoleccion' FROM containers WHERE id = :id RETURNING container_id");
        $statement->execute(['id' => $id]);
    } else {
        $statement = $db->prepare('UPDATE containers SET unit = :unit WHERE id = :id RETURNING id');
        $statement->execute(['id' => $id, 'unit' => $unit]);
    }

    if ($statement->fetchColumn() === false) {
        respond(404, ['error' => 'El contenedor no existe.']);
    }
    respond(200, ['ok' => true]);
} catch (JsonException) {
    respond(400, ['error' => 'JSON inválido.']);
} catch (PDOException $error) {
    error_log($error->getMessage());
    respond(503, ['error' => 'PostgreSQL no está disponible. Revisa la conexión y ejecuta el esquema.']);
}