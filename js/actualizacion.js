async function actualizarEcoRuta() {
  try {
    const datos = await request(API, { cache: 'no-store' });

    if (!Array.isArray(datos.bins)) throw new Error('La API no devolvió las lecturas.');

    const cambiaronLosDatos =
      JSON.stringify(datos.bins) !== JSON.stringify(state.bins) ||
      JSON.stringify(datos.base) !== JSON.stringify(state.base);

    if (cambiaronLosDatos) {
      state.bins = datos.bins;
      state.base = datos.base;
      state.loaded = true;
      render();
    }
  } catch (error) {
    console.warn('No se pudieron actualizar las lecturas:', error.message);
  } finally {
    setTimeout(actualizarEcoRuta, 5000);
  }
}

setTimeout(actualizarEcoRuta, 5000);