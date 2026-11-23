async function actualizarEcoRuta() {
  try {
    const datos = await request(API, { cache: 'no-store' });

    const cambiaronLosDatos =
      JSON.stringify(datos.bins) !== JSON.stringify(state.bins) ||
      JSON.stringify(datos.base) !== JSON.stringify(state.base);

    if (cambiaronLosDatos) {
      state.bins = datos.bins;
      state.base = datos.base;
      state.loaded = true;
      clearRoute();
      render();
    }
  } catch (error) {
    console.warn('No se pudieron actualizar las lecturas:', error.message);
  } finally {
    setTimeout(actualizarEcoRuta, 5000);
  }
}

setTimeout(actualizarEcoRuta, 5000);