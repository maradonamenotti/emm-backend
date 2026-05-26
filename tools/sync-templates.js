const http = require('http');
const https = require('https');

const LOCAL_URL = 'http://localhost:3001/api/crm/plantillas';
const PROD_URL = 'https://analiticos-backend-production.up.railway.app/api/crm/plantillas';

// Helper function to perform HTTP GET
function get(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON response from ${url}: ${data}`));
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

// Helper function to perform HTTP POST or PUT
function request(url, method, payload) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const urlObj = new URL(url);
    const body = JSON.stringify(payload);
    
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (url.startsWith('https') ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

async function run() {
  console.log('🔄 Iniciando sincronización de plantillas de local a producción...');
  
  // 1. Obtener plantillas locales
  let localTemplates = [];
  try {
    console.log(`📡 Obteniendo plantillas locales desde ${LOCAL_URL}...`);
    localTemplates = await get(LOCAL_URL);
    console.log(`✅ Se encontraron ${localTemplates.length} plantillas en local.`);
  } catch (error) {
    console.error('❌ Error al obtener plantillas locales. Asegúrate de que el backend local esté corriendo en el puerto 3001.');
    console.error(error.message);
    process.exit(1);
  }

  // 2. Obtener plantillas en producción
  let prodTemplates = [];
  try {
    console.log(`📡 Obteniendo plantillas en producción desde ${PROD_URL}...`);
    prodTemplates = await get(PROD_URL);
    console.log(`✅ Se encontraron ${prodTemplates.length} plantillas en producción.`);
  } catch (error) {
    console.error('❌ Error al obtener plantillas en producción.');
    console.error(error.message);
    process.exit(1);
  }

  // 3. Procesar y sincronizar
  let createdCount = 0;
  let updatedCount = 0;

  for (const localT of localTemplates) {
    // Buscar si existe en producción una plantilla con el mismo título y curso
    const existingProd = prodTemplates.find(
      (pt) => pt.titulo === localT.titulo && pt.curso === localT.curso
    );

    // Preparar payload de la plantilla (excluyendo id y creada_at)
    const payload = {
      titulo: localT.titulo,
      categoria: localT.categoria,
      curso: localT.curso,
      estado_sugerido: localT.estado_sugerido,
      texto: localT.texto,
      orden: localT.orden,
      activa: localT.activa
    };

    if (existingProd) {
      // Si el texto o algún campo es diferente, actualizamos
      const isDifferent = 
        existingProd.texto !== localT.texto ||
        existingProd.categoria !== localT.categoria ||
        existingProd.estado_sugerido !== localT.estado_sugerido ||
        existingProd.orden !== localT.orden ||
        existingProd.activa !== localT.activa;

      if (isDifferent) {
        console.log(`✏️  Actualizando plantilla "${localT.titulo}" (Curso: ${localT.curso || 'Todos'}) en producción...`);
        const updateUrl = `${PROD_URL}/${existingProd.id}`;
        const response = await request(updateUrl, 'PUT', payload);
        if (response.status === 200 || response.status === 201) {
          console.log(`   ✅ Sincronizada con éxito.`);
          updatedCount++;
        } else {
          console.error(`   ❌ Error al actualizar (${response.status}):`, response.body);
        }
      } else {
        console.log(`⏭️  Plantilla "${localT.titulo}" (Curso: ${localT.curso || 'Todos'}) ya está al día en producción. Omitiendo.`);
      }
    } else {
      // Si no existe, la creamos
      console.log(`➕ Creando nueva plantilla "${localT.titulo}" (Curso: ${localT.curso || 'Todos'}) en producción...`);
      const response = await request(PROD_URL, 'POST', payload);
      if (response.status === 200 || response.status === 201) {
        console.log(`   ✅ Creada con éxito.`);
        createdCount++;
      } else {
        console.error(`   ❌ Error al crear (${response.status}):`, response.body);
      }
    }
  }

  console.log(`\n🎉 Sincronización finalizada.`);
  console.log(`📈 Resultados: ${createdCount} creadas, ${updatedCount} actualizadas.`);
}

run().catch((err) => {
  console.error('❌ Ocurrió un error inesperado durante la ejecución:', err);
  process.exit(1);
});
