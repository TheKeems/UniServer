// The data object you want to send
const dataToSend = {
    username: 'JohnDoe',
    email: 'john@example.com',
    age: 28
};

function send(){
    console.log('sent');
    fetch('https://indexsite.onrender.com/api/data', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({key: 'value'})
    })
    .then(response => response.json())
    .then(data => {
        console.log('Success response from server:', data);
    })
    .catch((error) => {
        console.error('Error sending data:', error);
    });
}

