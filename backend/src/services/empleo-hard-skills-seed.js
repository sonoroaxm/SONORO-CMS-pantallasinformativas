// E-EMP-1 Task 3 — seed on-demand de 30 habilidades técnicas curadas SONORO
// Se dispara al crear el primer evento con rueda_type='empleo' de un tenant.
// Idempotente: ON CONFLICT (user_id, slug) DO NOTHING.

const HARD_SKILLS_ES = [
  ['excel-avanzado',       'Excel avanzado'],
  ['ofimatica-google',     'Google Workspace'],
  ['powerpoint',           'Presentaciones (PPT/Keynote)'],
  ['photoshop',            'Adobe Photoshop'],
  ['illustrator',          'Adobe Illustrator'],
  ['figma',                'Figma / diseño UI'],
  ['canva',                'Canva'],
  ['edicion-video',        'Edición de video'],
  ['python',               'Python'],
  ['javascript',           'JavaScript'],
  ['sql',                  'SQL / bases de datos'],
  ['html-css',             'HTML / CSS'],
  ['git',                  'Git / control de versiones'],
  ['power-bi',             'Power BI'],
  ['google-analytics',     'Google Analytics'],
  ['ingles-b2',            'Inglés B1-B2'],
  ['ingles-c1',            'Inglés C1+'],
  ['portugues',            'Portugués conversacional'],
  ['atencion-cliente',     'Atención al cliente'],
  ['ventas-consultivas',   'Ventas consultivas'],
  ['caja-efectivo',        'Caja / manejo de efectivo'],
  ['inventario',           'Gestión de inventario'],
  ['logistica',            'Logística / despachos'],
  ['conduccion',           'Conducción (licencia)'],
  ['soldadura',            'Soldadura'],
  ['electricidad-basica',  'Electricidad básica'],
  ['cocina-bar',           'Cocina / bar'],
  ['contabilidad-basica',  'Contabilidad básica'],
  ['nomina-rrhh',          'Nómina / RRHH básico'],
  ['gestion-proyectos',    'Gestión de proyectos'],
];

const CATEGORY = 'tech_sonoro';
const DIMENSION = 'hard';

async function seedEmpleoHardSkills(client, userId) {
  const values = [];
  const params = [userId];
  HARD_SKILLS_ES.forEach(([slug, label], i) => {
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

module.exports = { seedEmpleoHardSkills, HARD_SKILLS_ES };
