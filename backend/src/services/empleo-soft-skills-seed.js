// E-EMP-1 Task 2 — seed on-demand de 17 habilidades blandas curadas SONORO
// Se dispara al crear el primer evento con rueda_type='empleo' de un tenant.
// Idempotente: ON CONFLICT (user_id, slug) DO NOTHING.

const SOFT_SKILLS_ES = [
  ['comunicacion-efectiva',    'Comunicación efectiva'],
  ['trabajo-en-equipo',        'Trabajo en equipo'],
  ['adaptabilidad',            'Adaptabilidad'],
  ['resolucion-problemas',     'Resolución de problemas'],
  ['pensamiento-critico',      'Pensamiento crítico'],
  ['gestion-tiempo',           'Gestión del tiempo y organización'],
  ['responsabilidad-etica',    'Responsabilidad y ética profesional'],
  ['inteligencia-emocional',   'Inteligencia emocional'],
  ['empatia-respeto',          'Empatía y respeto'],
  ['liderazgo',                'Liderazgo'],
  ['creatividad-innovacion',   'Creatividad e innovación'],
  ['negociacion-conflictos',   'Negociación y manejo de conflictos'],
  ['aprendizaje-continuo',     'Aprendizaje continuo'],
  ['iniciativa-autonomia',     'Iniciativa y autonomía'],
  ['orientacion-cliente',      'Orientación al cliente'],
  ['resiliencia',              'Resiliencia'],
  ['pensamiento-analitico',    'Pensamiento analítico/numérico'],
];

const CATEGORY = 'soft_sonoro';
const DIMENSION = 'soft';

async function seedEmpleoSoftSkills(client, userId) {
  const values = [];
  const params = [userId];
  SOFT_SKILLS_ES.forEach(([slug, label], i) => {
    const base = i * 2 + 2;
    values.push(`($1, $${base}, $${base + 1}, '${CATEGORY}', '${DIMENSION}')`);
    params.push(slug, label);
  });
  const sql = `
    INSERT INTO events.rn_tags (user_id, slug, label, category, dimension)
    VALUES ${values.join(', ')}
    ON CONFLICT (user_id, slug) DO NOTHING
    RETURNING id
  `;
  const r = await client.query(sql, params);
  return r.rowCount;
}

module.exports = { seedEmpleoSoftSkills, SOFT_SKILLS_ES };
