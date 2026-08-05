// /const { createServer } = require('node:http');

const express = require('express');
const cors = require('cors');
const app = express();
const hostname = '0.0.0.0';
const port = process.env.PORT || 10000;

app.use(express.json());

app.use(cors()); 

app.post('/api/data', (req, res) => {
    const receivedData = req.body;
    console.log('Data received from client:', receivedData);

    res.status(200).json({ 
        message: 'Data received successfully!', 
        yourData: receivedData 
    });
});

app.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});