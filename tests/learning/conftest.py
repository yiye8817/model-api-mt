import pytest


@pytest.fixture
def store(tmp_path):
    from learning.store import LearningStore
    return LearningStore(tmp_path / 'learning')


@pytest.fixture
def source():
    return {'source_id': 'manual-a', 'origin': 'learning', 'title': '量子学习手册',
            'content_hash': 'first', 'locator': {}, 'status': 'ready'}


@pytest.fixture
def chunks():
    return [{'text': '量子叠加是多个状态的线性组合。', 'position': {'kind': 'lines', 'start_line': 1}, 'ordinal': 0}]
