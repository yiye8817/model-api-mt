"""Deterministic lexical matching; scores are relevance, never truth probabilities."""
import re
import unicodedata

APP_INTENTS = ('讯息', '问答', '工具调用', '网页控制', '图文理解', '音频理解',
               '代码编写', '文字润色', '数据分析', '生成图片', '生成音频', '未知')
STOP_BIGRAMS = frozenset(('什么', '如何', '怎么', '是否', '可以', '请问', '一个', '一下',
                         '我想', '帮我', '的是', '的吗', '告诉', '诉我'))


def tokens(text):
    text = unicodedata.normalize('NFKC', text).casefold()
    result = []
    for run in re.findall(r'[\u3400-\u9fff]+|[a-z0-9_]+', text):
        if re.match(r'[\u3400-\u9fff]', run):
            result.extend(run[i:i + 2] for i in range(len(run) - 1) if run[i:i + 2] not in STOP_BIGRAMS)
            if len(run) == 1:
                result.append(run)
        elif run not in {'the', 'a', 'an', 'is', 'are', 'how', 'what', 'to', 'of', 'or', 'and'}:
            result.append(run)
    return result


def fts_query(text):
    # Only tokens produced by our tokenizer enter FTS syntax.
    return ' OR '.join('"' + term + '"' for term in list(dict.fromkeys(tokens(text)))[:64])


def coverage(query, sample):
    terms = set(tokens(query))
    return len(terms & set(tokens(sample))) / len(terms) if terms else 0.0


# Explicit mapping: these are dataset labels, not a claim of full app coverage.
MASSIVE_MAPPING = {
    'news_query': '讯息', 'weather_query': '讯息', 'datetime_query': '问答',
    'datetime_convert': '问答', 'qa_factoid': '问答', 'qa_definition': '问答',
    'qa_currency': '问答', 'qa_maths': '问答', 'qa_stock': '讯息',
    'general_greet': '问答', 'general_praise': '问答', 'general_quirky': '问答',
    'general_joke': '问答',
}
for _label in (
    'alarm_query', 'alarm_remove', 'alarm_set', 'audio_volume_down', 'audio_volume_mute',
    'audio_volume_other', 'audio_volume_up', 'calendar_query', 'calendar_remove', 'calendar_set',
    'cooking_query', 'cooking_recipe', 'email_addcontact', 'email_query', 'email_querycontact',
    'email_sendemail', 'general_affirm', 'general_commandstop', 'general_confirm', 'general_dontcare',
    'general_explain', 'general_negate', 'general_repeat', 'iot_cleaning', 'iot_coffee',
    'iot_hue_lightchange', 'iot_hue_lightdim', 'iot_hue_lightoff', 'iot_hue_lighton',
    'iot_hue_lightup', 'iot_wemo_off', 'iot_wemo_on', 'lists_createoradd', 'lists_query',
    'lists_remove', 'music_dislikeness', 'music_likeness', 'music_query', 'music_settings',
    'play_audiobook', 'play_game', 'play_music', 'play_podcasts', 'play_radio',
    'recommendation_events', 'recommendation_locations', 'recommendation_movies',
    'social_post', 'social_query', 'takeaway_order', 'takeaway_query', 'transport_query',
    'transport_taxi', 'transport_ticket', 'transport_traffic',
):
    MASSIVE_MAPPING[_label] = '工具调用'


def unknown_intent():
    return {'intent': '未知', 'native_label': None, 'coverage': 0.0,
            'reason': '没有足够的本地样例匹配', 'sample': None, 'method': 'local-baseline'}
