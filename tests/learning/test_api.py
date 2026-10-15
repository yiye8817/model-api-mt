import io
import pytest
from flask import Flask
from learning.api import create_blueprint
from learning.runtime import LearningRuntime
from tests.learning.test_jobs import wait_terminal


@pytest.fixture
def learning_api(tmp_path):
    runtime = LearningRuntime(tmp_path, None, lambda:[], lambda:False, None, None)
    app = Flask(__name__); app.register_blueprint(create_blueprint(runtime.components))
    yield app.test_client(), runtime.components()
    runtime.close()


def test_reading_and_upload_do_not_require_hermes(learning_api):
    client, service = learning_api
    assert client.get('/api/learning/documents').status_code == 200
    assert client.post('/api/learning/analyze',json={'scope':{'mode':'all'}}).status_code == 503
    response = client.post('/api/learning/documents/upload',data={'files':[(io.BytesIO('量子状态。'.encode()),'手册.md'),(io.BytesIO(b'bad'),'bad.exe')]},content_type='multipart/form-data')
    assert response.status_code == 202
    assert response.json['accepted'] == 1 and response.json['rejected'] == 1
    item = next(i for i in response.json['items'] if i.get('job_id'))
    job = wait_terminal(service.store,item['job_id'])
    assert job['status'] == 'failed' and 'Hermes' in job['error']
    docs = client.get('/api/learning/documents').json
    assert docs['total'] == 1 and docs['items'][0]['title'] == '手册.md'
    doc = docs['items'][0]
    content = client.get('/api/learning/documents/'+doc['id']+'/content').json
    assert content['items'][0]['text'] == '量子状态。'


@pytest.mark.parametrize('path,payload',[('/questions',[]),('/questions',{'question':''}),('/documents/link',{'url':'http://127.0.0.1'}),('/archives/notes',{'origin':{'kind':'unknown'}})])
def test_bad_input_returns_json(learning_api,path,payload):
    client,_ = learning_api
    response = client.post('/api/learning'+path,json=payload)
    assert response.status_code in (400,503)
    assert 'error' in response.json


def test_pagination_and_missing_objects(learning_api):
    client,_ = learning_api
    assert client.get('/api/learning/documents?page_size=0').status_code == 400
    assert client.get('/api/learning/documents/missing').status_code == 404
    assert client.get('/api/learning/jobs/missing').status_code == 404
    assert client.get('/api/learning/graph').json['coverage'] == {'total':0,'analyzed':0}
