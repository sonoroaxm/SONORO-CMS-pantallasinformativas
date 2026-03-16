/**
 * ============================================
 * AUTO-RENOVACIÓN DE TOKEN JWT
 * ============================================
 * Renueva automáticamente el token antes de expirar
 * Agregar este script al final del <head> en dashboard.html
 */

(function() {
  // Configuración
  const LOGIN_EMAIL = 'sonoroaxm@gmail.com';
  const LOGIN_PASSWORD = 'sOnoro2025@';
  const API_URL = 'http://localhost:5000';
  const TOKEN_KEY = 'authToken';
  const REFRESH_INTERVAL = 60000; // Renovar cada 60 segundos
  const EXPIRY_BUFFER = 300000; // Renovar 5 minutos antes de expirar

  /**
   * Obtener token JWT nuevo
   */
  async function getNewToken() {
    try {
      const response = await fetch(`${API_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: LOGIN_EMAIL,
          password: LOGIN_PASSWORD
        })
      });

      if (!response.ok) {
        console.error('❌ Error al renovar token:', response.status);
        return null;
      }

      const data = await response.json();
      
      if (data.token) {
        localStorage.setItem(TOKEN_KEY, data.token);
        console.log('✅ Token renovado exitosamente');
        return data.token;
      }

      return null;
    } catch (error) {
      console.error('❌ Error renovando token:', error);
      return null;
    }
  }

  /**
   * Decodificar token JWT y obtener expiración
   */
  function getTokenExpiry(token) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;

      const decoded = JSON.parse(atob(parts[1]));
      return decoded.exp ? decoded.exp * 1000 : null; // Convertir a milisegundos
    } catch (error) {
      console.error('❌ Error decodificando token:', error);
      return null;
    }
  }

  /**
   * Verificar si el token está próximo a expirar
   */
  function isTokenExpiringSoon(token) {
    const expiry = getTokenExpiry(token);
    if (!expiry) return true;

    const now = Date.now();
    const timeUntilExpiry = expiry - now;

    console.log(`⏱️  Token expira en: ${Math.round(timeUntilExpiry / 1000)} segundos`);

    return timeUntilExpiry < EXPIRY_BUFFER;
  }

  /**
   * Inicializar auto-renovación
   */
  function initAutoTokenRefresh() {
    const token = localStorage.getItem(TOKEN_KEY);

    if (!token) {
      console.warn('⚠️  No hay token en localStorage. Intenta hacer login primero.');
      return;
    }

    // Renovar inmediatamente si está próximo a expirar
    if (isTokenExpiringSoon(token)) {
      console.log('🔄 Token próximo a expirar. Renovando...');
      getNewToken();
    }

    // Configurar renovación periódica
    setInterval(() => {
      const currentToken = localStorage.getItem(TOKEN_KEY);

      if (!currentToken) {
        console.warn('⚠️  Token no encontrado en localStorage');
        return;
      }

      if (isTokenExpiringSoon(currentToken)) {
        console.log('🔄 Renovando token...');
        getNewToken();
      }
    }, REFRESH_INTERVAL);

    console.log('✅ Auto-renovación de token inicializada');
    console.log(`   Intervalo de verificación: ${REFRESH_INTERVAL / 1000} segundos`);
    console.log(`   Buffer de expiración: ${EXPIRY_BUFFER / 1000} segundos`);
  }

  /**
   * Escuchar cambios en localStorage (para sincronizar entre pestañas)
   */
  window.addEventListener('storage', (event) => {
    if (event.key === TOKEN_KEY && event.newValue) {
      console.log('✅ Token actualizado en otra pestaña');
    }
  });

  /**
   * Iniciar cuando el DOM esté listo
   */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAutoTokenRefresh);
  } else {
    initAutoTokenRefresh();
  }

  // Exportar para usar manualmente si es necesario
  window.TokenManager = {
    getNewToken,
    getTokenExpiry,
    isTokenExpiringSoon,
    initAutoTokenRefresh
  };
})();
