fetch('http://localhost:3001/api/students')
  .then(res => res.json())
  .then(body => {
    if (!body.data) {
      console.log('No data field in response:', body);
      return;
    }
    console.log('Total students returned from API:', body.data.length);
    const inAnaliticos = body.data.filter(s => s.en_analiticos === true);
    console.log('Students with en_analiticos = true in API:', inAnaliticos.length);
    if (body.data.length > 0) {
      console.log('Sample student from API:', JSON.stringify(body.data[0], null, 2));
    }
  })
  .catch(err => {
    console.error('Failed to connect to API:', err.message);
  });
