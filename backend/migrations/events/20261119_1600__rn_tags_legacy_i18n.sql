-- Migration: i18n de 74 tags legacy (Deuda S217j paso 3)
-- Fecha: 2026-11-19
-- Scope: UPDATE label_en + label_pt de tags legacy sin traducción
-- (seed-rn-demo.sql original + tech_sonoro + soft_sonoro + Banca/Operaciones/etc.).
-- Traducción automática revisada por Daniel 2026-11-19.
-- Idempotente: WHERE label_en IS NULL OR label_pt IS NULL.
-- Forward-only. Rollback por fila: SET label_en=NULL, label_pt=NULL WHERE slug=...

SET search_path TO events, public;

-- ──────────────────────────────────────────────────────────────────────────
-- Scope NEGOCIOS · 28 tags
-- ──────────────────────────────────────────────────────────────────────────
UPDATE events.rn_tags SET label_en='Professional audio',         label_pt='Áudio profissional'          WHERE slug='audio-profesional'         AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Installation',               label_pt='Instalação'                  WHERE slug='instalacion'               AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Cold-chain logistics',       label_pt='Logística refrigerada'       WHERE slug='logistica-refrigerada'     AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Production',                 label_pt='Produção'                    WHERE slug='produccion'                AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Streaming',                  label_pt='Streaming'                   WHERE slug='streaming'                 AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Technology',                 label_pt='Tecnologia'                  WHERE slug='tecnologia'                AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Credit',                     label_pt='Crédito'                     WHERE slug='credito'                   AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Bancóldex',                  label_pt='Bancóldex'                   WHERE slug='bancoldex'                 AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='SME credit',                 label_pt='Crédito para PMEs'           WHERE slug='credito-pymes'             AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Transportation credit',      label_pt='Crédito para transporte'     WHERE slug='credito-transporte'        AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Microcredit',                label_pt='Microcrédito'                WHERE slug='micro-credito'             AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Microcredit',                label_pt='Microcrédito'                WHERE slug='microcredito'              AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Distributor in Peru',        label_pt='Distribuidor no Peru'        WHERE slug='distribuidor-en-peru'      AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Graphic design',             label_pt='Design gráfico'              WHERE slug='diseno-grafico'            AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Photography',                label_pt='Fotografia'                  WHERE slug='fotografia'                AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Video production',           label_pt='Produção de vídeo'           WHERE slug='video-produccion'          AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Digital marketing',          label_pt='Marketing digital'           WHERE slug='marketing-digital'         AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Catering',                   label_pt='Buffet'                      WHERE slug='catering'                  AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='AV equipment',               label_pt='Equipamento AV'              WHERE slug='equipos-av'                AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Large-format printing',      label_pt='Impressão em grande formato' WHERE slug='impresion-gran-formato'    AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Logistics',                  label_pt='Logística'                   WHERE slug='logistica'                 AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Strategic consulting',       label_pt='Consultoria estratégica'     WHERE slug='consultoria-estrategica'   AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Custom software',            label_pt='Software sob medida'         WHERE slug='software-a-medida'         AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Corporate insurance',        label_pt='Seguros corporativos'        WHERE slug='seguros-corporativos'      AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Commercial lawyer',          label_pt='Advogado comercial'          WHERE slug='abogado-comercial'         AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='IT recruiting',              label_pt='Recrutamento de TI'          WHERE slug='reclutamiento-ti'          AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Simultaneous interpreter',   label_pt='Intérprete simultâneo'       WHERE slug='traductor-simultaneo'      AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Outsourcing',                label_pt='Terceirização'               WHERE slug='outsorcing'                AND (label_en IS NULL OR label_pt IS NULL);

-- ──────────────────────────────────────────────────────────────────────────
-- Scope EMPLEO · soft skills · 17 tags
-- ──────────────────────────────────────────────────────────────────────────
UPDATE events.rn_tags SET label_en='Adaptability',                      label_pt='Adaptabilidade'                     WHERE slug='adaptabilidad'          AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Continuous learning',               label_pt='Aprendizado contínuo'               WHERE slug='aprendizaje-continuo'   AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Effective communication',           label_pt='Comunicação eficaz'                 WHERE slug='comunicacion-efectiva'  AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Creativity & innovation',           label_pt='Criatividade e inovação'            WHERE slug='creatividad-innovacion' AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Empathy & respect',                 label_pt='Empatia e respeito'                 WHERE slug='empatia-respeto'        AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Time management & organization',    label_pt='Gestão do tempo e organização'      WHERE slug='gestion-tiempo'         AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Initiative & autonomy',             label_pt='Iniciativa e autonomia'             WHERE slug='iniciativa-autonomia'   AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Emotional intelligence',            label_pt='Inteligência emocional'             WHERE slug='inteligencia-emocional' AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Leadership',                        label_pt='Liderança'                          WHERE slug='liderazgo'              AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Negotiation & conflict management', label_pt='Negociação e gestão de conflitos'   WHERE slug='negociacion-conflictos' AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Customer orientation',              label_pt='Orientação ao cliente'              WHERE slug='orientacion-cliente'    AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Analytical & numerical thinking',   label_pt='Pensamento analítico/numérico'      WHERE slug='pensamiento-analitico'  AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Critical thinking',                 label_pt='Pensamento crítico'                 WHERE slug='pensamiento-critico'    AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Resilience',                        label_pt='Resiliência'                        WHERE slug='resiliencia'            AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Problem solving',                   label_pt='Resolução de problemas'             WHERE slug='resolucion-problemas'   AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Professional responsibility & ethics', label_pt='Responsabilidade e ética profissional' WHERE slug='responsabilidad-etica' AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Teamwork',                          label_pt='Trabalho em equipe'                 WHERE slug='trabajo-en-equipo'      AND (label_en IS NULL OR label_pt IS NULL);

-- ──────────────────────────────────────────────────────────────────────────
-- Scope EMPLEO · tech / hard skills · 29 tags
-- ──────────────────────────────────────────────────────────────────────────
UPDATE events.rn_tags SET label_en='Adobe Illustrator',           label_pt='Adobe Illustrator'               WHERE slug='illustrator'          AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Adobe Photoshop',             label_pt='Adobe Photoshop'                 WHERE slug='photoshop'            AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Customer service',            label_pt='Atendimento ao cliente'          WHERE slug='atencion-cliente'     AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Cashier / cash handling',     label_pt='Caixa / manuseio de dinheiro'    WHERE slug='caja-efectivo'        AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Canva',                       label_pt='Canva'                           WHERE slug='canva'                AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Kitchen / bar',               label_pt='Cozinha / bar'                   WHERE slug='cocina-bar'           AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Driving (license)',           label_pt='Direção (CNH)'                   WHERE slug='conduccion'           AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Basic accounting',            label_pt='Contabilidade básica'            WHERE slug='contabilidad-basica'  AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Video editing',               label_pt='Edição de vídeo'                 WHERE slug='edicion-video'        AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Basic electrical',            label_pt='Eletricidade básica'             WHERE slug='electricidad-basica'  AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Advanced Excel',              label_pt='Excel avançado'                  WHERE slug='excel-avanzado'       AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Figma / UI design',           label_pt='Figma / design UI'               WHERE slug='figma'                AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Inventory management',        label_pt='Gestão de estoque'               WHERE slug='inventario'           AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Project management',          label_pt='Gestão de projetos'              WHERE slug='gestion-proyectos'    AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Git / version control',       label_pt='Git / controle de versão'        WHERE slug='git'                  AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Google Analytics',            label_pt='Google Analytics'                WHERE slug='google-analytics'     AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Google Workspace',            label_pt='Google Workspace'                WHERE slug='ofimatica-google'     AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='HTML / CSS',                  label_pt='HTML / CSS'                      WHERE slug='html-css'             AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='English B1-B2',               label_pt='Inglês B1-B2'                    WHERE slug='ingles-b2'            AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='English C1+',                 label_pt='Inglês C1+'                      WHERE slug='ingles-c1'            AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='JavaScript',                  label_pt='JavaScript'                      WHERE slug='javascript'           AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Payroll / basic HR',          label_pt='Folha de pagamento / RH básico'  WHERE slug='nomina-rrhh'          AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Conversational Portuguese',   label_pt='Português conversacional'        WHERE slug='portugues'            AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Power BI',                    label_pt='Power BI'                        WHERE slug='power-bi'             AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Presentations (PPT/Keynote)', label_pt='Apresentações (PPT/Keynote)'     WHERE slug='powerpoint'           AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Python',                      label_pt='Python'                          WHERE slug='python'               AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='SQL / databases',             label_pt='SQL / bancos de dados'           WHERE slug='sql'                  AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Welding',                     label_pt='Soldagem'                        WHERE slug='soldadura'            AND (label_en IS NULL OR label_pt IS NULL);
UPDATE events.rn_tags SET label_en='Consultative sales',          label_pt='Vendas consultivas'              WHERE slug='ventas-consultivas'   AND (label_en IS NULL OR label_pt IS NULL);

-- Verificación esperada tras ejecución:
-- SELECT COUNT(*) FROM events.rn_tags WHERE label_en IS NULL OR label_pt IS NULL;
-- → 0
